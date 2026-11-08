import { app } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import { updateEphemeralVmRuntimeStatus } from '../../shared/ephemeral-vm-runtime-store'
import { findWorkspaceEphemeralVmRuntime } from '../../shared/ephemeral-vm-workspace-runtime'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import {
  getEphemeralVmRecipeResultConnection,
  getEphemeralVmRecipeResultPairingCode
} from '../../shared/ephemeral-vm-recipes'
import {
  resolveEnvironment,
  updateEnvironmentFromPairingCode
} from '../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  EphemeralVmFailureError,
  ephemeralVmFailureFromError,
  pickEphemeralVmFailureCode
} from '../../shared/ephemeral-vm-failure-copy'
import { resumeEphemeralVmRuntime } from './runtime-service'
import { connectRuntimeOwnedSshTarget, refreshRuntimeOwnedSshTarget } from './runtime-ssh'
import { noteRecipeVmWakePairing } from './recipe-vm-wake-pairings'
import { getRuntimeOwnedSshTargetId } from '../ssh/connection/ssh-connection-store'
import { isSshUserDisconnected, sshUserDisconnectCount } from '../ssh/ssh-user-disconnect'
import type { VmWakeRequest } from '../runtime/workspaces/sleep/workspace-sleep-platform'
import { getRuntimeRecipeContext } from '../ipc/ephemeral-vm-recipe-context'
import { invalidateRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environments'

/** Wakes a workspace's suspended recipe VM on this host; callers go through WorkspaceSleepCoordinator.wakeVm. */
export async function resumeEphemeralVmWorkspace(
  store: Store,
  workspaceId: string,
  request: VmWakeRequest
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
    repoPath: recipeContext.repoPath,
    recipe: recipeContext.recipe,
    runtimeId: runtime.id
  })
  if (!result.ok) {
    throw new EphemeralVmFailureError({
      error: result.error,
      ...pickEphemeralVmFailureCode(result)
    })
  }
  if (!result.runtime.recipeResult) {
    return result.runtime
  }
  const connection = getEphemeralVmRecipeResultConnection(result.runtime.recipeResult)
  // SSH servers use their target and have no pairing to refresh.
  if (!result.skipped && connection.type !== 'ssh' && runtime.runtimeEnvironmentId) {
    const environmentId = runtime.runtimeEnvironmentId
    const recipeResult = result.runtime.recipeResult
    // The recipe already marked the VM running; a server Orca cannot pair with is still a failed resume.
    await recordResumeFailureOf(userDataPath, result.runtime.id, async () => {
      const pairingCode = getEphemeralVmRecipeResultPairingCode(recipeResult)
      if (!pairingCode) {
        throw new Error('Resume result did not include an Orca Server pairing code.')
      }
      const repaired = updateEnvironmentFromPairingCode(userDataPath, environmentId, {
        pairingCode
      })
      noteRecipeVmWakePairing(repaired.id, repaired.pairingRevision ?? repaired.createdAt)
      invalidateRuntimeEnvironmentTransport(environmentId)
    })
  }
  // Suspend tore down the runtime-owned SSH transport, so an SSH VM reconnects even when its
  // recipe had no resume step to run.
  if (connection.type === 'ssh') {
    // A Disconnect of the VM's SSH host, standing when this wake was accepted or made since, must
    // hold: the wake's own connect would otherwise lift it.
    if (request.sshHeld || vmSshUserDisconnects(runtime.id) !== request.sshUserDisconnects) {
      // The VM is up; the user's later Disconnect keeps its host disconnected until they connect,
      // which then dials the address the resume reported.
      const target = refreshRuntimeOwnedSshTarget({ runtimeId: result.runtime.id, connection })
      return updateEphemeralVmRuntimeStatus(userDataPath, result.runtime.id, {
        connectionMode: 'ssh',
        sshTargetId: target.id
      })
    }
    const ssh = await recordResumeFailureOf(userDataPath, result.runtime.id, () =>
      connectRuntimeOwnedSshTarget({ runtimeId: result.runtime.id, connection })
    )
    // The reconnect can move the server's tunnel and re-pair it; the waiting open expects that.
    const reached = resolveEnvironment(userDataPath, ssh.environmentId)
    noteRecipeVmWakePairing(reached.id, reached.pairingRevision ?? reached.createdAt)
    return updateEphemeralVmRuntimeStatus(userDataPath, result.runtime.id, {
      connectionMode: 'ssh',
      sshTargetId: ssh.targetId,
      runtimeEnvironmentId: ssh.environmentId
    })
  }
  return result.runtime
}

/** Runs a post-resume reconnect step; a failure marks the VM resume_failed with its reason. */
async function recordResumeFailureOf<T>(
  userDataPath: string,
  runtimeId: string,
  step: () => Promise<T> | T
): Promise<T> {
  try {
    return await step()
  } catch (error) {
    updateEphemeralVmRuntimeStatus(userDataPath, runtimeId, {
      status: 'resume_failed',
      lifecycleLastError: ephemeralVmFailureFromError(error)
    })
    throw error
  }
}

/** The wake request for a workspace's VM, taken when the wake is accepted. */
export function acceptEphemeralVmWorkspaceWake(workspaceId: string): VmWakeRequest {
  const runtime = findWorkspaceEphemeralVmRuntime(app.getPath('userData'), workspaceId)
  if (!runtime) {
    return { sshHeld: false, sshUserDisconnects: 0 }
  }
  return {
    sshHeld: isSshUserDisconnected(getRuntimeOwnedSshTargetId(runtime.id)),
    sshUserDisconnects: vmSshUserDisconnects(runtime.id)
  }
}

function vmSshUserDisconnects(runtimeId: string): number {
  return sshUserDisconnectCount(getRuntimeOwnedSshTargetId(runtimeId))
}
