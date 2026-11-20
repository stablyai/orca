import { publishToDocuments, registerAppHandler } from './app-registry/app-handler-registry'
import { BrowserWindow, shell } from 'electron'
import type { KeybindingActionId, KeybindingFileSnapshot } from '../../shared/keybindings/types'
import type { KeybindingService } from '../keybindings/keybinding-service'
import { rebuildAppMenu } from '../menu/register-app-menu'

function broadcastKeybindingsChanged(snapshot: KeybindingFileSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      publishToDocuments('keybindings:changed', snapshot, { sourceId: window.webContents.id })
    }
  }
  rebuildAppMenu()
}

export function registerKeybindingHandlers(
  service: KeybindingService,
  onChanged?: () => void
): void {
  registerAppHandler('keybindings:get', () => service.getSnapshot())

  registerAppHandler('keybindings:ensureFile', () => {
    const snapshot = service.ensureFile()
    broadcastKeybindingsChanged(snapshot)
    onChanged?.()
    return snapshot
  })

  registerAppHandler(
    'keybindings:setAction',
    (_event, args: { actionId: KeybindingActionId; bindings: string[] | null }) => {
      const snapshot = service.setActionBindings(args.actionId, args.bindings)
      broadcastKeybindingsChanged(snapshot)
      onChanged?.()
      return snapshot
    }
  )

  registerAppHandler('keybindings:reload', () => {
    const snapshot = service.reload()
    broadcastKeybindingsChanged(snapshot)
    onChanged?.()
    return snapshot
  })

  registerAppHandler('keybindings:openFile', async () => {
    const snapshot = service.ensureFile()
    const error = await shell.openPath(snapshot.path)
    if (error) {
      throw new Error(error)
    }
    return snapshot
  })

  registerAppHandler('keybindings:revealFile', () => {
    const snapshot = service.ensureFile()
    shell.showItemInFolder(snapshot.path)
    return snapshot
  })
}
