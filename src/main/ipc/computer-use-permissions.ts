import { ipcMain } from 'electron'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../shared/computer-use-permissions-types'

export function registerComputerUsePermissionHandlers(): void {
  ipcMain.handle(
    'computerUsePermissions:openSetup',
    async (
      _event,
      args?: { id?: ComputerUsePermissionId }
    ): Promise<ComputerUsePermissionSetupResult> => {
      const { openComputerUsePermissions } =
        await import('../computer/macos-computer-use-permissions')
      return openComputerUsePermissions(args?.id)
    }
  )
  ipcMain.handle(
    'computerUsePermissions:getStatus',
    async (): Promise<ComputerUsePermissionStatusResult> => {
      const { getComputerUsePermissionStatus } =
        await import('../computer/macos-computer-use-permissions')
      return getComputerUsePermissionStatus()
    }
  )
}
