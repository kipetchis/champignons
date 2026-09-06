/* Service worker — carte des champignons.
   Incrémente VERSION à chaque modification d'un fichier précaché. */

const VERSION = "v15";
const SHELL = "champi-shell-" + VERSION;
const RUNTIME = "champi-runtime-" + VERSION;
const DATA = "champi-data-" + VERSION;

/* Chemins relatifs : ils se résolvent depuis l'emplacement de ce fichier,
   donc le site fonctionne aussi bien à la racine que dans un sous-dossier. */
const A_PRECACHER = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
  "./favicon.svg",
  "./leaflet.js",
  "./leaflet.css"
];

const API = "api.open-meteo.com";
const CDN = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net",
             "fr.wikipedia.org", "upload.wikimedia.org"];
const GEO = "data.geopf.fr";

/* Les tuiles gardent un cache non versionné : elles ne changent pas
   quand la page évolue, et les reperdre à chaque mise à jour serait
   pénible pour qui prépare une sortie hors réseau. */
const TUILES = "champi-tuiles";
const TUILES_MAX = 700;

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(A_PRECACHER))
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((noms) => Promise.all(
        noms.filter((n) => n.startsWith("champi-") && n !== TUILES && !n.endsWith(VERSION))
            .map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

/* Réseau d'abord, cache en secours. Le cache est ouvert AVANT le fetch,
   pour que le clone se fasse sans attente intermédiaire, et l'écriture
   est attendue pour qu'elle ne soit pas coupée par la mise en veille. */
async function reseauDAbord(req, nomCache) {
  const cache = await caches.open(nomCache);
  try {
    const rep = await fetch(req);
    if (rep && rep.ok) {
      try {
        await cache.put(req, rep.clone());
      } catch (err) {
        /* quota plein ou réponse non stockable : on sert quand même la page */
      }
    }
    return rep;
  } catch (err) {
    const vieux = await cache.match(req);
    if (vieux) return vieux;
    throw err;
  }
}

/* Garde le cache des tuiles sous une taille raisonnable. */
async function limite(nom, max) {
  const cache = await caches.open(nom);
  const cles = await cache.keys();
  const trop = cles.length - max;
  for (let i = 0; i < trop; i++) await cache.delete(cles[i]);
}

/* Cache d'abord, rafraîchi en arrière-plan. */
async function cacheDAbord(req, nomCache) {
  const cache = await caches.open(nomCache);
  const connu = await cache.match(req);
  const reseau = fetch(req).then((rep) => {
    if (rep && (rep.ok || rep.type === "opaque")) cache.put(req, rep.clone());
    return rep;
  }).catch(() => null);
  return connu || reseau || Response.error();
}

/* Navigation : réseau d'abord, repli sur la page précachée hors connexion.
   Le clone est pris tout de suite, sinon le corps est déjà consommé
   quand caches.open() se résout. */
async function navigation(e) {
  try {
    const rep = await fetch(e.request);
    const copie = rep.clone();
    e.waitUntil(
      caches.open(SHELL).then((c) => c.put("./index.html", copie))
    );
    return rep;
  } catch (err) {
    const cache = await caches.open(SHELL);
    return (await cache.match("./index.html", { ignoreSearch: true }))
        || (await cache.match("./"))
        || Response.error();
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  if (req.mode === "navigate") {
    e.respondWith(navigation(e));
    return;
  }

  /* Relevés de pluie : la dernière réponse connue vaut mieux qu'une erreur. */
  if (url.hostname === API) {
    e.respondWith(reseauDAbord(req, DATA));
    return;
  }

  /* Polices et Leaflet : versionnés dans leur URL, donc figés. */
  if (CDN.indexOf(url.hostname) !== -1) {
    e.respondWith(cacheDAbord(req, RUNTIME));
    return;
  }

  /* Requêtes WFS : la bbox change sans arrêt, elles n'ont pas leur place
     dans le cache de tuiles. Dernière réponse connue en secours. */
  if (url.hostname === GEO && url.pathname.indexOf("/wfs") === 0) {
    e.respondWith(reseauDAbord(req, DATA));
    return;
  }

  /* Tuiles IGN et BD Forêt : servies depuis le cache si déjà vues,
     ce qui rend consultable hors réseau la zone déjà parcourue. */
  if (url.hostname === GEO) {
    e.respondWith(cacheDAbord(req, TUILES));
    if (Math.random() < 0.05) e.waitUntil(limite(TUILES, TUILES_MAX));
    return;
  }

  /* Reste du site. */
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((connu) => connu || reseauDAbord(req, RUNTIME))
    );
  }
});
