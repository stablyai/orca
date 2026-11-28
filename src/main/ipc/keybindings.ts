import { ipcMain, shell } from 'electron'
import type { KeybindingActionId, KeybindingFileSnapshot } from '../../shared/keybindings/types'
import type { KeybindingService } from '../keybindings/keybinding-service'
import { broadcastKeybindingsChanged } from '../keybindings/keybindings-broadcast'
import type { IpcHandleRegistrar } from './lazy-ipc-handle-group'

export function registerKeybindingHandlers(
  service: KeybindingService,
  onChanged?: () => void,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  // Every handler that commits a snapshot publishes it to all windows and plugins, before any
  // shell work that could fail, so no reader keeps an older map or predicate.
  const publish = (snapshot: KeybindingFileSnapshot): KeybindingFileSnapshot => {
    broadcastKeybindingsChanged(snapshot)
    onChanged?.()
    return snapshot
  }

  ipc.handle('keybindings:get', () => service.getSnapshot())

  ipc.handle('keybindings:ensureFile', () => publish(service.ensureFile()))

  ipc.handle(
    'keybindings:setAction',
    (_event, args: { actionId: KeybindingActionId; bindings: string[] | null }) =>
      publish(service.setActionBindings(args.actionId, args.bindings))
  )

  ipc.handle('keybindings:reload', () => publish(service.reload()))

  ipc.handle('keybindings:openFile', async () => {
    const snapshot = publish(service.ensureFile())
    const error = await shell.openPath(snapshot.path)
    if (error) {
      throw new Error(error)
    }
    return snapshot
  })

  ipc.handle('keybindings:revealFile', () => {
    const snapshot = publish(service.ensureFile())
    shell.showItemInFolder(snapshot.path)
    return snapshot
  })
}
