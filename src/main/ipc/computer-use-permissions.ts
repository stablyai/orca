import { app, BrowserWindow, ipcMain } from 'electron'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionResetResult,
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../shared/computer-use-permissions-types'
import {
  bindPermissionStatusGateToAppActivity,
  computerUsePermissionStatusGate,
  type PermissionStatusReadOptions
} from '../computer/macos-computer-use-permission-status-gate'

export function registerComputerUsePermissionHandlers(): void {
  if (process.platform === 'darwin') {
    bindPermissionStatusGateToAppActivity(computerUsePermissionStatusGate, {
      onDeparture: (listener) => app.on('did-resign-active', listener),
      onReturn: (listener) => app.on('did-become-active', listener),
      isAppActive: () => BrowserWindow.getFocusedWindow() !== null
    })
  }
  ipcMain.handle(
    'computerUsePermissions:openSetup',
    async (
      _event,
      args?: { id?: ComputerUsePermissionId }
    ): Promise<ComputerUsePermissionSetupResult> => {
      const { openComputerUsePermissions } =
        await import('../computer/macos-computer-use-permissions')
      computerUsePermissionStatusGate.invalidate()
      return openComputerUsePermissions(args?.id)
    }
  )
  ipcMain.handle(
    'computerUsePermissions:getStatus',
    (_event, args?: PermissionStatusReadOptions): Promise<ComputerUsePermissionStatusResult> =>
      computerUsePermissionStatusGate.read({ background: args?.background === true })
  )
  ipcMain.handle(
    'computerUsePermissions:reset',
    async (): Promise<ComputerUsePermissionResetResult> => {
      const { resetComputerUsePermissions } =
        await import('../computer/macos-computer-use-permissions')
      computerUsePermissionStatusGate.invalidate()
      try {
        return await resetComputerUsePermissions()
      } finally {
        // Reads during the reset may have cached the pre-reset grants.
        computerUsePermissionStatusGate.invalidate()
      }
    }
  )
}
