// Site prompts live in browser-site-permission-prompt.ts; other unlisted permissions are denied.
const AUTO_GRANTED_BROWSER_PERMISSIONS = new Set([
  'fullscreen',
  'clipboard-sanitized-write',
  // Chromium requests this even though Electron's permission union omits it.
  'persistent-storage',
  // Chromium still requires user activation for pointer lock.
  'pointerLock',
  // Match Orca's unpartitioned third-party cookie policy; request and check must agree.
  // This also grants unpartitioned localStorage/IndexedDB handles, unlike ambient globals.
  // Revisit if partitioning becomes configurable: Electron does not persist a STORAGE_ACCESS grant.
  'storage-access'
])
// Top-level storage access requires Related Website Sets, which Orca does not supply.

export function isAutoGrantedBrowserSessionPermission(permission: string): boolean {
  return AUTO_GRANTED_BROWSER_PERMISSIONS.has(permission)
}
