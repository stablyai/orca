import type { BrowserWindow } from 'electron'
import { deferAppKitSceneMutation } from '../desktop-integration/appkit-scene-mutation'
import { macWindowsHiddenToMenuBar } from '../main-window/macos-menu-bar-hidden-window'
import { safelyRevealWindow } from './focus-existing-window'

export function createMacAppActivationHandler(options: {
  getWindow: () => BrowserWindow | null
  requestActivation: () => void
}): () => void {
  return () => {
    const window = options.getWindow()
    // Refocusing a macOS window can race its scene-backed Space transition.
    if (!window || window.isDestroyed()) {
      options.requestActivation()
    } else if (macWindowsHiddenToMenuBar.has(window)) {
      deferAppKitSceneMutation(() => {
        if (macWindowsHiddenToMenuBar.has(window)) {
          safelyRevealWindow(window)
        }
      })
    }
  }
}
