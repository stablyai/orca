import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { KeyboardLayoutSnapshot } from '../../shared/keyboard-layout-snapshot'

const KEYBOARD_LAYOUT_ADDON = 'orca_keyboard_layout.node'

type KeyboardLayoutRead = { snapshot: KeyboardLayoutSnapshot; keyboardType: number }
type KeyboardLayoutAddon = {
  read: () => KeyboardLayoutRead | null
  keyboardType: () => number
}

const requireNative = createRequire(import.meta.url)
let addon: KeyboardLayoutAddon | null = null
let loadFailureLogged = false
// Only a live input-source subscription can tell us when a cached read goes stale.
let cacheAuthorized = false
let cached: KeyboardLayoutRead | null = null

function loadAddon(): KeyboardLayoutAddon | null {
  if (addon) {
    return addon
  }
  try {
    addon = requireNative(join(process.resourcesPath, KEYBOARD_LAYOUT_ADDON)) as KeyboardLayoutAddon
  } catch (error) {
    // Not memoized: a later request retries the load; log once so focus can't flood the log.
    if (!loadFailureLogged) {
      loadFailureLogged = true
      console.warn('[keyboard-layout] native layout reader unavailable:', error)
    }
  }
  return addon
}

/** Current layout from an in-process read; served from cache until the input source or keyboard type changes. */
export function readMacKeyboardLayoutSnapshot(): KeyboardLayoutSnapshot | null {
  if (process.platform !== 'darwin') {
    return null
  }
  const reader = loadAddon()
  if (!reader) {
    return null
  }
  try {
    if (cached && cached.keyboardType === reader.keyboardType()) {
      return cached.snapshot
    }
    cached = null
    const read = reader.read()
    if (read && cacheAuthorized) {
      cached = read
    }
    return read?.snapshot ?? null
  } catch {
    return null
  }
}

export function invalidateMacKeyboardLayoutSnapshot(): void {
  cached = null
}

export function setMacKeyboardLayoutCacheAuthorized(authorized: boolean): void {
  cacheAuthorized = authorized
  cached = null
}
