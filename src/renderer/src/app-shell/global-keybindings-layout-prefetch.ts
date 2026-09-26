import { prefetchLayoutCharacters } from '@/lib/keyboard-layout/layout-base-character'

/**
 * Warms the active layout's character cache for the window-level shortcut dispatchers.
 *
 * Why: the cache resolves asynchronously, and Option chords fall back to US-QWERTY
 * physical codes while it is empty. Only macOS composes Option into a character with
 * no Latin logical key, so other platforms never consult the cache.
 */
export function warmKeyboardLayoutCache(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') {
    return
  }
  prefetchLayoutCharacters()
}
