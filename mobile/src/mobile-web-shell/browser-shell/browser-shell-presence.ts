// Shares an origin with the desktop web client, so keep a key of its own.
export const BROWSER_SHELL_PAIRING_STORAGE_KEY = 'orca.mobileWeb.pairing'
export const BROWSER_SHELL_PAIRING_HASH_PARAM = 'pairing'

// Cheap enough for the entry: the shell itself loads only for a document opened from a pairing link.
export function hasBrowserShellPairing(): boolean {
  if (new URLSearchParams(window.location.hash.slice(1)).has(BROWSER_SHELL_PAIRING_HASH_PARAM)) {
    return true
  }
  try {
    return localStorage.getItem(BROWSER_SHELL_PAIRING_STORAGE_KEY) !== null
  } catch {
    return false
  }
}
