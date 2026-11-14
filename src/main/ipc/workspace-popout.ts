import { ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { KeybindingService } from '../keybindings/keybinding-service'
import { isTrustedUIRenderer } from './ui'
import {
  closeAllWorkspacePopouts,
  createOrFocusWorkspacePopout,
  dockWorkspacePopout,
  focusWorkspacePopout,
  getWorkspacePopoutEntryForWebContents,
  getWorkspacePopoutTarget,
  isWorkspacePopoutRenderer,
  listWorkspacePopouts,
  setWorkspacePopoutTarget
} from '../window/workspace-popout-window'
import {
  isWorkspacePopoutDockArgs,
  validateWorkspacePopoutTarget,
  type WorkspacePopoutEntrySummary,
  type WorkspacePopoutOpenResult,
  type WorkspacePopoutTarget
} from '../../shared/workspace-popout/workspace-popout-contract'

function isWorkspacePopoutEnabled(store: Store): boolean {
  return store.getSettings().experimentalWorkspacePopout === true
}

export function registerWorkspacePopoutHandlers(
  store: Store,
  keybindings?: KeybindingService
): void {
  ipcMain.removeHandler('workspacePopout:open')
  ipcMain.removeHandler('workspacePopout:publishTarget')
  ipcMain.removeHandler('workspacePopout:dock')
  ipcMain.removeHandler('workspacePopout:focus')
  ipcMain.removeHandler('workspacePopout:list')
  ipcMain.removeHandler('workspacePopout:getTarget')

  store.onSettingsChanged((updates, settings) => {
    if ('experimentalWorkspacePopout' in updates && settings.experimentalWorkspacePopout !== true) {
      closeAllWorkspacePopouts('flag-disabled')
    }
  })

  ipcMain.handle('workspacePopout:open', (event, args: unknown): WorkspacePopoutOpenResult => {
    if (!isTrustedUIRenderer(event.sender)) {
      return { status: 'rejected', reason: 'invalid-payload' }
    }
    if (!isWorkspacePopoutEnabled(store)) {
      return { status: 'rejected', reason: 'flag-disabled' }
    }
    const validation = validateWorkspacePopoutTarget(args)
    if (!validation.valid) {
      return { status: 'rejected', reason: validation.reason }
    }
    return createOrFocusWorkspacePopout(store, validation.target, {
      getKeybindings: () => keybindings?.getOverrides()
    })
  })

  ipcMain.handle('workspacePopout:publishTarget', (event, args: unknown): void => {
    if (!isTrustedUIRenderer(event.sender)) {
      return
    }
    const validation = validateWorkspacePopoutTarget(args)
    if (!validation.valid) {
      return
    }
    setWorkspacePopoutTarget(validation.target.worktreeId, validation.target)
  })

  ipcMain.handle('workspacePopout:dock', (event, args: unknown): void => {
    if (!isWorkspacePopoutDockArgs(args)) {
      return
    }
    const isTrusted = isTrustedUIRenderer(event.sender)
    const isSatellite = isWorkspacePopoutRenderer(event.sender)
    if (!isTrusted && !isSatellite) {
      return
    }
    if (isSatellite) {
      const entry = getWorkspacePopoutEntryForWebContents(event.sender)
      if (entry?.worktreeId !== args.worktreeId) {
        return
      }
    }
    dockWorkspacePopout(args.worktreeId)
  })

  ipcMain.handle('workspacePopout:focus', (event, args: unknown): boolean => {
    if (!isWorkspacePopoutDockArgs(args)) {
      return false
    }
    if (!isTrustedUIRenderer(event.sender)) {
      return false
    }
    return focusWorkspacePopout(args.worktreeId)
  })

  ipcMain.handle('workspacePopout:list', (event): readonly WorkspacePopoutEntrySummary[] => {
    if (!isTrustedUIRenderer(event.sender)) {
      return []
    }
    return listWorkspacePopouts()
  })

  ipcMain.handle('workspacePopout:getTarget', (event): WorkspacePopoutTarget | null => {
    if (!isWorkspacePopoutRenderer(event.sender)) {
      return null
    }
    return getWorkspacePopoutTarget(event.sender)
  })
}
