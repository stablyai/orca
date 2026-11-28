import { BrowserWindow } from 'electron'
import type { KeybindingFileSnapshot } from '../../shared/keybindings/types'
import { refreshGrabShortcutPolicies } from '../browser/guest-lifecycle/input/shortcuts/browser-guest-grab-shortcuts'
import { rebuildAppMenu } from '../menu/register-app-menu'

export function broadcastKeybindingsChanged(snapshot: KeybindingFileSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    // A window torn down mid-loop must not keep the others on a stale map.
    try {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('keybindings:changed', snapshot)
      }
    } catch (error) {
      console.error('[keybindings] Failed to send keybindings to a window:', error)
    }
  }
  refreshGrabShortcutPolicies()
  rebuildAppMenu()
}
