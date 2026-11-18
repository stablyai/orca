import { ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { KeybindingService } from '../../keybindings/keybinding-service'
import { openTerminalPopout } from '../../window/terminal-popout-window'
import { isTrustedUIRenderer } from '../ui'
import { isValidPtyId } from './terminal-preview'

export function registerTerminalPopoutHandlers(
  store: Store,
  keybindings?: KeybindingService
): void {
  ipcMain.removeHandler('terminalPopout:open')
  ipcMain.handle('terminalPopout:open', (event, args: { ptyId?: unknown }): void => {
    if (!isTrustedUIRenderer(event.sender) || !isValidPtyId(args?.ptyId)) {
      return
    }
    openTerminalPopout(store, args.ptyId, () => keybindings?.getOverrides())
  })
}
