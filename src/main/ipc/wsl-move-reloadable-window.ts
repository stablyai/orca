/** The app window as the WSL move's write hold reloads it (wsl-move-window-write-hold.ts). */
import type { WebContents } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { WslMoveReloadableWindow } from '../persistence/moving-wsl-projects/wsl-move-window-write-hold'

/**
 * Settings cannot restore its page, so a reload from it would open General (and keep reopening
 * there on launch); land on the workspace view, which the move already focused on its projects.
 */
export function leaveSettingsForWslMoveReload(ui: Pick<Store, 'getUI' | 'updateUI'>): void {
  if (ui.getUI().activeView === 'settings') {
    ui.updateUI({ activeView: 'terminal' })
  }
}

export function wslMoveReloadableWindow(contents: WebContents): WslMoveReloadableWindow {
  return {
    isDestroyed: () => contents.isDestroyed(),
    reload: () => contents.reload(),
    allowUnload: () => {
      const allow = (event: Electron.Event): void => event.preventDefault()
      contents.on('will-prevent-unload', allow)
      return () => contents.removeListener('will-prevent-unload', allow)
    },
    onLoadedOrGone: (listener: () => void) => {
      contents.once('did-finish-load', listener)
      contents.once('destroyed', listener)
      return () => {
        contents.removeListener('did-finish-load', listener)
        contents.removeListener('destroyed', listener)
      }
    }
  }
}
