const AUTO_GRANTED_BROWSER_PERMISSIONS = new Set([
  'fullscreen',
  // Agent-browser clipboard commands execute via CDP in this session; denying
  // them breaks trusted runtime commands even when invoked with a user gesture.
  'clipboard-read',
  'clipboard-sanitized-write',
  // User-opened browser pages need these profile-scoped grants to complete
  // normal site flows like web push setup and durable app storage.
  'notifications',
  // Chromium can request this at runtime even though Electron's TS union does
  // not list it; chatgpt.com uses it to keep browser storage from eviction.
  'persistent-storage',
  // Chromium still requires user activation, so this only removes Orca's
  // otherwise unactionable denial for immersive browser apps.
  'pointerLock',
  // Orca allows unpartitioned third-party cookies, so cross-site frames already send them; denying
  // this only rejected the API and burned the caller's user gesture. Not cookies-only: the same
  // permission also hands requestStorageAccess({localStorage: true}) a handle onto unpartitioned
  // localStorage/IndexedDB, though ambient globals stay partitioned. Chrome grants the same
  // permission under the same cookie policy, so this is parity. Electron has no auto-grant, so
  // the embedder must answer, and check must agree with request or compliant sites fall back to
  // the gesture path. Revisit if Orca ever gains a cookie or storage-partitioning control: the
  // handle is gated separately and would survive, but Electron never writes the STORAGE_ACCESS
  // content setting, so cookie access would stay blocked while the promise still resolved — and
  // sites that reload on success would loop.
  'storage-access'
])
// 'top-level-storage-access' is deliberately absent: Chromium gates requestStorageAccessFor() on
// Related Website Sets rather than cookie policy, and Orca has no such source, so the rationale
// above does not transfer to it.

export function isAutoGrantedBrowserSessionPermission(permission: string): boolean {
  return AUTO_GRANTED_BROWSER_PERMISSIONS.has(permission)
}
