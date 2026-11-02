import { app } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import {
  findWorkspaceEphemeralVmRuntime,
  updateEphemeralVmRuntimeStatus
} from '../../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import {
  getEphemeralVmRecipeResultConnection,
  getEphemeralVmRecipeResultPairingCode
} from '../../shared/ephemeral-vm-recipes'
import { updateEnvironmentFromPairingCode } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { resumeEphemeralVmRuntime } from './runtime-service'
import { connectRuntimeOwnedSshTarget } from './runtime-ssh'
import { getRuntimeRecipeContext } from '../ipc/ephemeral-vm-recipe-context'
import { invalidateRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environments'

/** Wakes a workspace's suspended recipe VM on this host; callers go through WorkspaceSleepCoordinator.wakeVm. */
export async function resumeEphemeralVmWorkspace(
  store: Store,
  workspaceId: string
): Promise<EphemeralVmRuntimeRecord | null> {
  const userDataPath = app.getPath('userData')
  const runtime = findWorkspaceEphemeralVmRuntime(userDataPath, workspaceId)
  if (!runtime) {
    return null
  }
  if (runtime.status !== 'suspended' && runtime.status !== 'resume_failed') {
    return runtime
  }
  const recipeContext = getRuntimeRecipeContext(store, userDataPath, runtime.id)
  const result = await resumeEphemeralVmRuntime({
    userDataPath,
    repoPath: recipeContext.repo.repo.path,
    recipe: recipeContext.recipe,
    runtimeId: runtime.id
  })
  if (!result.ok) {
    throw new Error(result.error)
  }
  const connection = getEphemeralVmRecipeResultConnection(result.runtime.recipeResult)
  // SSH servers use their target and have no pairing to refresh.
  if (!result.skipped && connection.type !== 'ssh' && runtime.runtimeEnvironmentId) {
    const pairingCode = getEphemeralVmRecipeResultPairingCode(result.runtime.recipeResult)
    if (!pairingCode) {
      throw new Error('Resume result did not include an Orca Server pairing code.')
    }
    updateEnvironmentFromPairingCode(userDataPath, runtime.runtimeEnvironmentId, {
      pairingCode
    })
    invalidateRuntimeEnvironmentTransport(runtime.runtimeEnvironmentId)
  }
  if (!result.skipped && connection.type === 'ssh') {
    try {
      const ssh = await connectRuntimeOwnedSshTarget({
        runtimeId: result.runtime.id,
        connection
      })
      return updateEphemeralVmRuntimeStatus(userDataPath, result.runtime.id, {
        connectionMode: 'ssh',
        sshTargetId: ssh.targetId,
        runtimeEnvironmentId: ssh.environmentId
      })
    } catch (error) {
      updateEphemeralVmRuntimeStatus(userDataPath, result.runtime.id, {
        status: 'resume_failed'
      })
      throw error
    }
  }
  return result.runtime
}
