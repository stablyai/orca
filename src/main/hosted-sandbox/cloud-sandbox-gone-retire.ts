import { updateEphemeralVmRuntimeStatus } from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { releaseEphemeralVmRuntimeEnvironments } from '../ephemeral-vm/runtime-environment-release'
import {
  retireRemovedRuntimeEnvironment,
  type RemovedServerStore
} from '../ipc/runtime-environments/runtime-environment-removal-cleanup'
import { invalidateRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environments'
import { publishRuntimeEnvironmentCatalogChanged } from '../ipc/runtime-environments/runtime-environment-catalog-broadcast'

/**
 * A sandbox destroyed out of band goes the way the app's own delete takes a destroyed one
 * (cleanupOwnedEphemeralVmRuntime after its destroy): the record is cleaned and its server
 * retired. The window's catalog refresh then purges that host's project and setup, so its clone
 * can never come back as a folder project.
 */
export async function retireGoneCloudSandbox(
  userDataPath: string,
  store: RemovedServerStore | undefined,
  runtime: EphemeralVmRuntimeRecord
): Promise<void> {
  updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
    status: 'cleaned',
    cleanupStatus: 'succeeded',
    cleanupLastError: null
  })
  await releaseEphemeralVmRuntimeEnvironments(userDataPath, runtime, (environmentId) => {
    if (store) {
      void retireRemovedRuntimeEnvironment(
        environmentId,
        invalidateRuntimeEnvironmentTransport,
        store,
        userDataPath
      )
    }
  })
  publishRuntimeEnvironmentCatalogChanged()
}
