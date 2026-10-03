import { ipcMain } from 'electron'
import type {
  OrcadManagedCancelStopResult,
  OrcadManagedDeployResult,
  OrcadManagedRecoveryResult,
  OrcadManagedRollbackResult,
  OrcadManagedStopResult
} from '../../shared/orcad-managed-runtime'
import {
  cancelManagedOrcadStop,
  recoverManagedOrcadEnvironment,
  rollbackManagedOrcadEnvironment,
  stopManagedOrcadEnvironment,
  updateManagedOrcadEnvironment
} from '../ssh/orcad-runtime-lifecycle'
import { retireRemovedRuntimeEnvironment } from './runtime-environment-removal-cleanup'
import { requiredString } from './orcad-runtime-lifecycle-handlers'

export function registerOrcadRuntimeMaintenanceHandlers(options: {
  getUserDataPath: () => string
  getActiveEnvironmentId: () => string | null | undefined
  invalidateTransport: (environmentId: string) => Promise<void> | void
}): void {
  ipcMain.handle(
    'runtimeEnvironments:updateOrcad',
    async (
      _event,
      args: { selector: string; force?: boolean }
    ): Promise<OrcadManagedDeployResult> => {
      const result = await updateManagedOrcadEnvironment(options.getUserDataPath(), {
        selector: requiredString(args?.selector, 'Server'),
        force: args?.force === true
      })
      // Why: a restarted orcad drops the old connection; reconnect on the new one.
      if (result.outcome === 'updated') {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:rollbackOrcad',
    async (_event, args: { selector: string }): Promise<OrcadManagedRollbackResult> => {
      const result = await rollbackManagedOrcadEnvironment(options.getUserDataPath(), {
        selector: requiredString(args?.selector, 'Server')
      })
      if (result.outcome === 'rolled-back') {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:recoverOrcad',
    async (_event, args: { selector: string }): Promise<OrcadManagedRecoveryResult> => {
      const result = await recoverManagedOrcadEnvironment(options.getUserDataPath(), {
        selector: requiredString(args?.selector, 'Server')
      })
      if (result.outcome === 'recovered' && result.activeVersion) {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:stopOrcad',
    async (_event, args: { selector: string }): Promise<OrcadManagedStopResult> =>
      stopManagedOrcadEnvironment(
        options.getUserDataPath(),
        { selector: requiredString(args?.selector, 'Server') },
        {
          isActiveEnvironment: (environmentId) =>
            options.getActiveEnvironmentId() === environmentId,
          retireLocalState: (environmentId) =>
            retireRemovedRuntimeEnvironment(environmentId, options.invalidateTransport)
        }
      )
  )
  ipcMain.handle(
    'runtimeEnvironments:cancelOrcadStop',
    async (_event, args: { selector: string }): Promise<OrcadManagedCancelStopResult> =>
      cancelManagedOrcadStop(options.getUserDataPath(), {
        selector: requiredString(args?.selector, 'Server')
      })
  )
}
