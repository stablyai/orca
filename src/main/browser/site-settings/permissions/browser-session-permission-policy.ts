import {
  type BrowserSitePermission,
  BROWSER_SITE_PERMISSIONS
} from '../../../../shared/browser-site-permission'

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

const SITE_PERMISSION_BY_ELECTRON_PERMISSION: Partial<Record<string, BrowserSitePermission>> = {
  geolocation: 'location',
  notifications: 'notifications',
  'clipboard-read': 'clipboard',
  midi: 'midi',
  midiSysex: 'midi',
  'window-management': 'window-management',
  'idle-detection': 'idle-detection',
  // Chromium 150 asks loopback-network for 127.0.0.1; local-network-access is the legacy name.
  'local-network-access': 'local-network',
  'local-network': 'local-network',
  'loopback-network': 'local-network'
}

const SITE_PERMISSION_BY_MEDIA_TYPE: Partial<Record<string, BrowserSitePermission>> = {
  video: 'camera',
  audio: 'microphone'
}

/** Null means no site prompt applies; an empty device list must not grant media access. */
export function browserSitePermissionsFor(
  permission: string,
  mediaTypes: readonly string[] | undefined
): BrowserSitePermission[] | null {
  if (permission === 'media') {
    const requested = new Set((mediaTypes ?? []).map((type) => SITE_PERMISSION_BY_MEDIA_TYPE[type]))
    // Preserve camera-before-microphone prompt order regardless of Chromium's order.
    return BROWSER_SITE_PERMISSIONS.filter((sitePermission) => requested.has(sitePermission))
  }
  const sitePermission = SITE_PERMISSION_BY_ELECTRON_PERMISSION[permission]
  return sitePermission ? [sitePermission] : null
}
