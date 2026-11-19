import type { BrowserWindow } from 'electron'

export function createMacAppActivationHandler(options: {
  getWindow: () => BrowserWindow | null
  requestActivation: () => void
}): () => void {
  return () => {
    const window = options.getWindow()
    // Refocusing a macOS window can race its scene-backed Space transition.
    if (!window || window.isDestroyed()) {
      options.requestActivation()
    }
  }
}
