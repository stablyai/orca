import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from './lazy-ipc-handle-group'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionResetResult,
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../shared/computer/computer-use-permissions-types'
import { computerUsePermissionStatusGate } from '../computer/macos-permissions/macos-computer-use-permission-status-gate'
import { mainI18n } from '../i18n/main-i18n'

export function registerComputerUsePermissionHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  ipc.handle(
    'computerUsePermissions:openSetup',
    async (
      _event,
      args?: { id?: ComputerUsePermissionId }
    ): Promise<ComputerUsePermissionSetupResult> => {
      const { openComputerUsePermissions } =
        await import('../computer/macos-permissions/macos-computer-use-permissions')
      return openComputerUsePermissions(args?.id, {
        locale: mainI18n.resolvedLanguage ?? mainI18n.language
      })
    }
  )
  ipc.handle('computerUsePermissions:getStatus', (): Promise<ComputerUsePermissionStatusResult> =>
    computerUsePermissionStatusGate.read()
  )
  ipc.handle(
    'computerUsePermissions:reset',
    async (): Promise<ComputerUsePermissionResetResult> => {
      const { resetComputerUsePermissions } =
        await import('../computer/macos-permissions/macos-computer-use-permissions')
      return resetComputerUsePermissions()
    }
  )
}
