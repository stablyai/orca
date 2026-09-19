import { ipcMain } from 'electron'
import type { OrcadLiveMigrationContext } from '../ssh/orcad-live-migration-selection'
import type {
  OrcadManagedCancelStopResult,
  OrcadManagedDeployResult,
  OrcadManagedPendingMigration,
  OrcadManagedRecoveryResult,
  OrcadManagedRollbackResult,
  OrcadManagedRuntimeStatus,
  OrcadManagedStopResult
} from '../../shared/orcad-managed-runtime'
import type { OrcadMigrationPreflight } from '../../shared/orcad-migration-preflight'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { clearBrowserRoutePartitionStorageForEnvironment } from '../browser/browser-route-partition-storage-runtime'
import {
  cancelManagedOrcadStop,
  createManagedOrcadEnvironment,
  getManagedOrcadRuntimeStatus,
  listPendingManagedOrcadMigrations,
  preflightManagedOrcadTarget,
  recoverManagedOrcadEnvironment,
  rollbackManagedOrcadEnvironment,
  stopManagedOrcadEnvironment,
  updateManagedOrcadEnvironment
} from '../ssh/orcad-runtime-lifecycle'
import { forgetRuntimeEnvironmentConnectivityState } from './runtime-environment-connectivity-handlers'
import { registerOrcadSshProvisioningHandlers } from './orcad-ssh-provisioning-handlers'
import { registerOrcadOutgoingRecoveryHandlers } from './orcad-outgoing-recovery-handlers'
import type { OrcadOutgoingRecoveryRuntime } from '../ssh/orcad-outgoing-recovery-selection'

export function registerOrcadRuntimeLifecycleHandlers(options: {
  getUserDataPath: () => string
  runtime?: OrcadOutgoingRecoveryRuntime
  liveMigrationContext?: OrcadLiveMigrationContext
  getActiveEnvironmentId: () => string | null | undefined
  invalidateTransport: (environmentId: string) => Promise<void> | void
}): void {
  registerOrcadSshProvisioningHandlers(options.getUserDataPath)
  registerOrcadOutgoingRecoveryHandlers(
    options.getUserDataPath,
    options.runtime,
    options.liveMigrationContext
  )
  ipcMain.handle(
    'runtimeEnvironments:listPendingOrcadMigrations',
    (): OrcadManagedPendingMigration[] =>
      listPendingManagedOrcadMigrations(options.getUserDataPath())
  )
  ipcMain.handle(
    'runtimeEnvironments:preflightOrcadTarget',
    (_event, args: { sshTargetId: string }): OrcadMigrationPreflight =>
      preflightManagedOrcadTarget(requiredString(args.sshTargetId, 'SSH target'))
  )
  ipcMain.handle(
    'runtimeEnvironments:deployOrcad',
    async (_event, args: { name: string; sshTargetId: string; force?: boolean }) =>
      createManagedOrcadEnvironment(options.getUserDataPath(), {
        name: requiredString(args.name, 'Server name'),
        sshTargetId: requiredString(args.sshTargetId, 'SSH target'),
        force: args.force === true
      })
  )
  ipcMain.handle(
    'runtimeEnvironments:updateOrcad',
    async (
      _event,
      args: { selector: string; force?: boolean }
    ): Promise<OrcadManagedDeployResult> => {
      const result = await updateManagedOrcadEnvironment(options.getUserDataPath(), {
        selector: requiredString(args.selector, 'Server'),
        force: args.force === true
      })
      if (result.outcome !== 'deferred') {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:getOrcadStatus',
    (_event, args: { selector: string }): Promise<OrcadManagedRuntimeStatus> =>
      getManagedOrcadRuntimeStatus(
        options.getUserDataPath(),
        requiredString(args.selector, 'Server')
      )
  )
  ipcMain.handle(
    'runtimeEnvironments:rollbackOrcad',
    async (_event, args: { selector: string }): Promise<OrcadManagedRollbackResult> => {
      const result = await rollbackManagedOrcadEnvironment(options.getUserDataPath(), {
        selector: requiredString(args.selector, 'Server')
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
      const result = await recoverManagedOrcadEnvironment(
        options.getUserDataPath(),
        {
          selector: requiredString(args.selector, 'Server')
        },
        { isActiveEnvironment: (id) => options.getActiveEnvironmentId() === id }
      )
      if (result.outcome === 'recovered' && result.activeVersion) {
        await options.invalidateTransport(result.environment.id)
      }
      return result
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:stopOrcad',
    async (_event, args: { selector: string }): Promise<OrcadManagedStopResult> => {
      const selector = requiredString(args.selector, 'Server')
      const environment = resolveEnvironment(options.getUserDataPath(), selector)
      if (options.getActiveEnvironmentId() === environment.id) {
        throw new Error('Choose another Active Server in Advanced before stopping this server.')
      }
      const result = await stopManagedOrcadEnvironment(
        options.getUserDataPath(),
        { selector: environment.id },
        {
          invalidateTransport: options.invalidateTransport,
          isActiveEnvironment: (environmentId) =>
            options.getActiveEnvironmentId() === environmentId,
          cleanupLocalState: async (environmentId) => {
            forgetRuntimeEnvironmentConnectivityState(environmentId)
            await clearBrowserRoutePartitionStorageForEnvironment(environmentId)
          }
        }
      )
      return result
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:cancelOrcadStop',
    (_event, args: { selector: string }): Promise<OrcadManagedCancelStopResult> =>
      cancelManagedOrcadStop(options.getUserDataPath(), {
        selector: requiredString(args.selector, 'Server')
      })
  )
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value.trim()
}
