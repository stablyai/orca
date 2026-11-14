import type { Store } from '../persistence/loading-store/store'
import {
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { ephemeralVmFailureFromError } from '../../shared/ephemeral-vm-failure-copy'
import { getRuntimeRecipeContext } from '../ipc/ephemeral-vm-recipe-context'
import { invalidateRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environments'
import { retireRemovedRuntimeEnvironment } from '../ipc/runtime-environments/catalog/runtime-environment-removal-cleanup'
import { releaseEphemeralVmRuntimeEnvironments } from './runtime-environment-release'
import { cleanupEphemeralVmRuntime } from './runtime-service'
import { removeEphemeralVmRuntimeSshTarget } from './runtime-ssh-cleanup'
import { removeRuntimeOwnedSshTarget } from './runtime-ssh'
import { isEphemeralVmProvisionLive } from './runtime-provisioning-persistence'

/** Destroys a recorded VM and releases what Orca holds for it. The one path for the desktop's
 *  cleanup and a failed CLI create; concurrent calls share one destroy run. */
export async function cleanupOwnedEphemeralVmRuntime(
  store: Store,
  userDataPath: string,
  runtimeId: string
): Promise<EphemeralVmRuntimeRecord> {
  const runtime = listEphemeralVmRuntimes(userDataPath).find((entry) => entry.id === runtimeId)
  if (!runtime) {
    throw new Error(`Unknown ephemeral VM runtime: ${runtimeId}`)
  }
  if (runtime.status === 'provisioning' && isEphemeralVmProvisionLive(runtime.id)) {
    // Why: don't mark a create in flight as cleanup_failed; its own outcome settles the row.
    throw new Error(`Ephemeral VM runtime is still provisioning: ${runtime.id}`)
  }
  let result
  if (runtime.cleanupStatus === 'succeeded') {
    result = { ok: true as const, runtime, skipped: false }
  } else {
    let resolved: ReturnType<typeof getRuntimeRecipeContext>
    try {
      resolved = getRuntimeRecipeContext(store, userDataPath, runtime.id)
    } catch (error) {
      const failed = updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
        status: 'cleanup_failed',
        cleanupStatus: 'failed',
        cleanupLastAttemptAt: Date.now(),
        cleanupLastError: ephemeralVmFailureFromError(error)
      })
      return removeEphemeralVmRuntimeSshTarget({
        userDataPath,
        runtime: failed,
        removeTarget: removeRuntimeOwnedSshTarget
      })
    }
    result = await cleanupEphemeralVmRuntime({
      userDataPath,
      repoPath: resolved.repoPath,
      recipe: resolved.recipe,
      runtimeId: runtime.id
    })
  }
  if (result.ok) {
    try {
      await releaseEphemeralVmRuntimeEnvironments(userDataPath, runtime, (environmentId) => {
        void retireRemovedRuntimeEnvironment(
          environmentId,
          invalidateRuntimeEnvironmentTransport,
          store,
          userDataPath
        )
      })
    } catch {
      // Cleanup of provider resources matters more than hiding a stale local
      // environment row; users can still remove that manually.
    }
  }
  if (!result.ok) {
    return result.runtime
  }
  return removeEphemeralVmRuntimeSshTarget({
    userDataPath,
    runtime: result.runtime,
    removeTarget: removeRuntimeOwnedSshTarget
  })
}
