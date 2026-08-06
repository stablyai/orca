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
  'pointerLock'
])

export function isAutoGrantedBrowserSessionPermission(permission: string): boolean {
  return AUTO_GRANTED_BROWSER_PERMISSIONS.has(permission)
}
