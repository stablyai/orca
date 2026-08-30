import type { BrowserWindow } from 'electron'

export function createMacAppActivationHandler(options: {
  getWindow: () => BrowserWindow | null
  isWindowReachable: (window: BrowserWindow) => boolean
  requestActivation: () => void
}): () => void {
  return () => {
    const window = options.getWindow()
    // Why: re-focusing an existing macOS window can race its scene-backed Space transition.
    if (
      !window ||
      window.isDestroyed() ||
      !window.isVisible() ||
      !options.isWindowReachable(window)
    ) {
      options.requestActivation()
    }
  }
}
