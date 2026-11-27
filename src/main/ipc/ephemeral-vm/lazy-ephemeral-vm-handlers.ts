import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { PluginService } from '../../plugins/plugin-service'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

const EPHEMERAL_VM_STORE_FILES = [
  'orca-ephemeral-vm-runtimes.json',
  'orca-ephemeral-vm-runtimes-write-ahead.json'
] as const

export const EPHEMERAL_VM_IPC_CHANNELS = [
  'ephemeralVm:listRecipes',
  'ephemeralVm:listRecipeCatalog',
  'ephemeralVm:doctor',
  'ephemeralVm:provision',
  'ephemeralVm:cancelProvision',
  'ephemeralVm:publishPendingCheckouts',
  'ephemeralVm:listPendingCheckouts',
  'ephemeralVm:listCredentialEnvNames',
  'ephemeralVm:listRuntimes',
  'ephemeralVm:attachWorkspace',
  'ephemeralVm:cleanup',
  'ephemeralVm:stopCleanup',
  'ephemeralVm:forgetRuntime',
  'ephemeralVm:getCleanupCommand'
] as const

async function hasPersistedEphemeralVmState(userDataPath: string): Promise<boolean> {
  const checks = await Promise.all(
    EPHEMERAL_VM_STORE_FILES.map((file) =>
      access(join(userDataPath, file)).then(
        () => true,
        () => false
      )
    )
  )
  return checks.some(Boolean)
}

export function registerLazyEphemeralVmHandlers(store: Store, pluginService?: PluginService): void {
  let startupReconciled = false
  const reconcileOnce = async (): Promise<void> => {
    if (startupReconciled) {
      return
    }
    startupReconciled = true
    const { reconcileInterruptedEphemeralVmProvisionsOnStartup } =
      await import('../../ephemeral-vm/runtime-provisioning-persistence')
    reconcileInterruptedEphemeralVmProvisionsOnStartup(app.getPath('userData'))
  }

  registerLazyIpcHandleGroup(EPHEMERAL_VM_IPC_CHANNELS, async (ipc) => {
    const { registerEphemeralVmHandlers } = await import('./ephemeral-vm')
    registerEphemeralVmHandlers(store, pluginService, ipc, {
      skipStartupReconcile: startupReconciled
    })
    startupReconciled = true
  })

  // Only load ephemeral-VM reconciliation at startup if persisted VM state files exist on disk.
  void hasPersistedEphemeralVmState(app.getPath('userData'))
    .then((exists) => (exists ? reconcileOnce() : undefined))
    .catch(() => {})
}
