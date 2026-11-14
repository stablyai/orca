import { ipcMain } from 'electron'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionResetResult,
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../shared/computer-use-permissions-types'
import { computerUsePermissionStatusGate } from '../computer/macos-permissions/macos-computer-use-permission-status-gate'
import { mainI18n } from '../i18n/main-i18n'

export function registerComputerUsePermissionHandlers(): void {
  ipcMain.handle(
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
  ipcMain.handle(
    'computerUsePermissions:getStatus',
    (): Promise<ComputerUsePermissionStatusResult> => computerUsePermissionStatusGate.read()
  )
  ipcMain.handle(
    'computerUsePermissions:reset',
    async (): Promise<ComputerUsePermissionResetResult> => {
      const { resetComputerUsePermissions } =
        await import('../computer/macos-permissions/macos-computer-use-permissions')
      return resetComputerUsePermissions()
    }
  )
}
