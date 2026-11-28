import { ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import {
  registerManagedServerActions,
  type ManagedServerActions
} from '../../runtime/hosts/management/managed-server-actions-registry'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import { clearPublishedManagedServer } from '../ssh/ssh-renderer-broadcast'

export type LazyRuntimeEnvironmentHandlersOptions = {
  store: Store
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => Promise<void>
}

function createLazyManagedServerActions(
  options: LazyRuntimeEnvironmentHandlersOptions
): ManagedServerActions {
  let cached: Promise<ManagedServerActions> | null = null
  const load = (): Promise<ManagedServerActions> => {
    if (!cached) {
      cached = Promise.all([
        import('./managed-orcad/managed-orcad-actions'),
        import('./managed-orcad/runtime-environment-managed-tunnel')
      ])
        .then(([{ createManagedOrcadActions }, { clearManagedServerNotes }]) =>
          createManagedOrcadActions({
            getUserDataPath: options.getUserDataPath,
            getActiveEnvironmentId: () => options.store.getSettings().activeRuntimeEnvironmentId,
            invalidateTransport: options.invalidateTransport,
            clearHostServerStatus: clearPublishedManagedServer,
            clearHostServerNotes: clearManagedServerNotes,
            store: options.store
          })
        )
        .catch((error) => {
          cached = null
          throw error
        })
    }
    return cached
  }
  return {
    status: async (selector) => (await load()).status(selector),
    update: async (selector, force, pastLiveTerminals, endInProcessTerminals) =>
      (await load()).update(selector, force, pastLiveTerminals, endInProcessTerminals),
    rollback: async (selector) => (await load()).rollback(selector),
    recover: async (selector, acceptChangedState) =>
      (await load()).recover(selector, acceptChangedState),
    stop: async (selector) => (await load()).stop(selector),
    cancelStop: async (selector) => (await load()).cancelStop(selector),
    forget: async (selector) => (await load()).forget(selector),
    forgetRedundant: async (selector) => (await load()).forgetRedundant(selector)
  }
}

export function registerLazyRuntimeEnvironmentHandlers(
  options: LazyRuntimeEnvironmentHandlersOptions
): void {
  const { store, getUserDataPath, invalidateTransport } = options

  registerLazyIpcHandleGroup(
    ['runtimeEnvironments:prepareBrowserClientHostPlacement'],
    async (ipc) => {
      const { registerRuntimeEnvironmentBrowserClientHostHandler } =
        await import('./browser-hosting/runtime-environment-browser-client-host-handler')
      registerRuntimeEnvironmentBrowserClientHostHandler(
        {
          getUserDataPath,
          getSettings: () => store.getSettings()
        },
        ipc
      )
    }
  )

  ipcMain.removeHandler('runtimeEnvironments:retryConnectionsNow')
  registerLazyIpcHandleGroup(['runtimeEnvironments:retryConnectionsNow'], async (ipc) => {
    const { registerRuntimeEnvironmentRecoveryHandler } =
      await import('./connectivity/runtime-environment-recovery-handler')
    registerRuntimeEnvironmentRecoveryHandler(ipc)
  })

  registerLazyIpcHandleGroup(['runtimeEnvironments:repairFromPairingCode'], async (ipc) => {
    const { registerRuntimeEnvironmentRepairHandler } =
      await import('./pairing/runtime-environment-repair-handler')
    registerRuntimeEnvironmentRepairHandler({ getUserDataPath, invalidateTransport }, ipc)
  })

  registerLazyIpcHandleGroup(
    ['runtimeEnvironments:linkSshAccess', 'runtimeEnvironments:unlinkSshAccess'],
    async (ipc) => {
      const { registerRuntimeSshAccessHandlers } =
        await import('./connectivity/runtime-ssh-access-handlers')
      registerRuntimeSshAccessHandlers({ getUserDataPath, invalidateTransport }, ipc)
    }
  )

  registerLazyIpcHandleGroup(
    ['runtimeEnvironments:deployOrcad', 'runtimeEnvironments:getOrcadStatus'],
    async (ipc) => {
      const { registerOrcadRuntimeLifecycleHandlers } =
        await import('./managed-orcad/orcad-runtime-lifecycle-handlers')
      registerOrcadRuntimeLifecycleHandlers({ getUserDataPath }, ipc)
    }
  )

  registerLazyIpcHandleGroup(
    [
      'runtimeEnvironments:convertSshHostToManagedOrcad',
      'runtimeEnvironments:listPendingOrcadMigrations'
    ],
    async (ipc) => {
      const { registerOrcadRuntimeConversionHandlers } =
        await import('./managed-orcad/orcad-runtime-conversion-handlers')
      registerOrcadRuntimeConversionHandlers(getUserDataPath, ipc)
    }
  )

  registerLazyIpcHandleGroup(
    [
      'runtimeEnvironments:previewOrcadDeltaMove',
      'runtimeEnvironments:moveOrcadDelta',
      'runtimeEnvironments:keepOrcadServerVersion'
    ],
    async (ipc) => {
      const { registerOrcadDeltaMoveHandlers } =
        await import('./managed-orcad/orcad-delta-move-handlers')
      registerOrcadDeltaMoveHandlers(getUserDataPath, ipc)
    }
  )

  registerLazyIpcHandleGroup(['runtimeEnvironments:allowOrcadMoveLeavingBehind'], async (ipc) => {
    const { registerOrcadLeaveBehindHandlers } =
      await import('./managed-orcad/orcad-leave-behind-handlers')
    registerOrcadLeaveBehindHandlers(ipc)
  })

  // CLI runtime RPC uses managedServer actions even before any desktop maintenance IPC fires.
  registerManagedServerActions(createLazyManagedServerActions(options))
  registerLazyIpcHandleGroup(
    [
      'runtimeEnvironments:updateOrcad',
      'runtimeEnvironments:rollbackOrcad',
      'runtimeEnvironments:recoverOrcad',
      'runtimeEnvironments:restartOrcad',
      'runtimeEnvironments:reclaimOrcadStaleLock',
      'runtimeEnvironments:stopOrcad',
      'runtimeEnvironments:cancelOrcadStop',
      'runtimeEnvironments:forgetOrcad'
    ],
    async (ipc) => {
      const [{ registerOrcadRuntimeMaintenanceHandlers }, { clearManagedServerNotes }] =
        await Promise.all([
          import('./managed-orcad/orcad-runtime-maintenance-handlers'),
          import('./managed-orcad/runtime-environment-managed-tunnel')
        ])
      registerOrcadRuntimeMaintenanceHandlers(
        {
          getUserDataPath,
          getActiveEnvironmentId: () => store.getSettings().activeRuntimeEnvironmentId,
          invalidateTransport,
          clearHostServerStatus: clearPublishedManagedServer,
          clearHostServerNotes: clearManagedServerNotes,
          store
        },
        ipc
      )
    }
  )
}
