import { app } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import { updateEphemeralVmRuntimeStatus } from '../../shared/ephemeral-vm-runtime-store'
import { findWorkspaceEphemeralVmRuntime } from '../../shared/ephemeral-vm-workspace-runtime'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import {
  getEphemeralVmRecipeResultConnection,
  getEphemeralVmRecipeResultPairingCode
} from '../../shared/ephemeral-vm-recipes'
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  EphemeralVmFailureError,
  ephemeralVmFailureFromError,
  pickEphemeralVmFailureCode
} from '../../shared/ephemeral-vm-failure-copy'
import { resumeEphemeralVmRuntime } from './runtime-service'
import { connectRuntimeOwnedSshTarget, refreshRuntimeOwnedSshTarget } from './runtime-ssh'
import { noteRecipeVmWakePairing } from './recipe-vm-wake-pairings'
import { applyResumedRuntimePairing } from './runtime-resume-pairing'
import { getRuntimeOwnedSshTargetId } from '../ssh/targets/ssh-target-runtime-ownership'
import {
  isSshUserDisconnected,
  sshUserDisconnectCount
} from '../ssh/connection/ssh-user-disconnect'
import type { VmWakeRequest } from '../runtime/workspaces/sleep/workspace-sleep-platform'
import { getRuntimeRecipeContext } from '../ipc/ephemeral-vm-recipe-context'
import { invalidateRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environments'
import {
  getRemoteRuntimeSharedControlDiagnostics,
  getRuntimeEnvironmentStatusOwner,
  reconnectRemoteRuntimeSharedControlConnection
} from '../ipc/runtime-environments/connections/runtime-environment-request-connections'
import {
  clearRuntimeEnvironmentContactLoss,
  isRuntimeEnvironmentContactLost
} from '../ipc/runtime-environments/status/runtime-environment-contact-loss'
import { isRuntimeEnvironmentManuallyDisconnected } from '../ipc/runtime-environments/connectivity/runtime-environment-manual-disconnect'
import { getRegisteredSshState } from '../ssh/targets/ssh-target-registry'
import { isRecipeVmLostContact } from './recipe-vm-lost-contact'

/** Wakes a workspace's suspended (or lost) recipe VM on this host; callers go through WorkspaceSleepCoordinator.wakeVm. */
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
  // A VM recorded as up whose host Orca gave up reaching may have been stopped or reclaimed by its
  // provider (#34089): its recipe's resume brings it back. A failure there keeps the record as it
  // was, so a VM that was only out of reach is still reconnected as before.
  const lostContact =
    !request.sshHeld &&
    isRecipeVmLostContact(runtime, {
      readSshStatus: (targetId) => getRegisteredSshState(targetId)?.status,
      isServerContactLost: isPairedServerContactLost
    })
  if (runtime.status !== 'suspended' && runtime.status !== 'resume_failed' && !lostContact) {
    return runtime
  }
  const restoreAfterFailedRecovery = (): void => {
    if (lostContact) {
      // The record stays as it was; a lifecycle error only shows on a resume_failed VM.
      updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, { status: runtime.status })
    }
  }
  // After the recipe marked the VM running, an SSH host Orca cannot reach again is still a failed
  // resume, saved with its reason so the row can explain it after a restart.
  const failAfterResume = (error: unknown): void => {
    if (lostContact) {
      restoreAfterFailedRecovery()
      return
    }
    updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
      status: 'resume_failed',
      lifecycleLastError: ephemeralVmFailureFromError(error)
    })
  }
  const recipeContext = getRuntimeRecipeContext(store, userDataPath, runtime.id)
  if (lostContact && runtime.connectionMode === 'orca-server' && !recipeContext.recipe.resume) {
    // Nothing can restart this VM, and only the user can tell whether it is gone. Retry the
    // server now, and say what is left; the record and the workspace stay as they are.
    if (runtime.runtimeEnvironmentId) {
      reestablishWokenServer(userDataPath, runtime.runtimeEnvironmentId)
    }
    throw new Error(RECIPE_VM_UNREACHABLE_WITHOUT_RESUME_MESSAGE)
  }
  const result = await resumeEphemeralVmRuntime({
    userDataPath,
    repoPath: recipeContext.repoPath,
    recipe: recipeContext.recipe,
    runtimeId: runtime.id
  })
  if (!result.ok) {
    restoreAfterFailedRecovery()
    throw new EphemeralVmFailureError({
      error: result.error,
      ...pickEphemeralVmFailureCode(result)
    })
  }
  if (lostContact && runtime.runtimeEnvironmentId) {
    // The resume restarted the VM; its server's old failures say nothing about the new boot.
    clearRuntimeEnvironmentContactLoss(runtime.runtimeEnvironmentId)
  }
  if (!result.runtime.recipeResult) {
    return result.runtime
  }
  const connection = getEphemeralVmRecipeResultConnection(result.runtime.recipeResult)
  // SSH servers use their target and have no pairing to refresh.
  if (!result.skipped && connection.type !== 'ssh' && runtime.runtimeEnvironmentId) {
    // A pairing failure leaves the VM running: retrying the recipe's resume on it would fail.
    const pairingCode = getEphemeralVmRecipeResultPairingCode(result.runtime.recipeResult)
    if (!pairingCode) {
      throw new Error('Resume result did not include an Orca Server pairing code.')
    }
    const { environment } = await applyResumedRuntimePairing({
      userDataPath,
      environmentId: runtime.runtimeEnvironmentId,
      pairingCode,
      invalidateTransport: invalidateRuntimeEnvironmentTransport
    })
    noteRecipeVmWakePairing(
      environment.id,
      environment.pairingRevision ?? environment.createdAt,
      true
    )
  }
  if (connection.type !== 'ssh' && runtime.runtimeEnvironmentId) {
    reestablishWokenServer(userDataPath, runtime.runtimeEnvironmentId)
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
    try {
      const ssh = await connectRuntimeOwnedSshTarget({
        runtimeId: result.runtime.id,
        connection
      })
      // The reconnect can move the server's tunnel and re-pair it; the waiting open expects that.
      const reached = await resolveEnvironment(userDataPath, ssh.environmentId)
      noteRecipeVmWakePairing(reached.id, reached.pairingRevision ?? reached.createdAt)
      const woken = updateEphemeralVmRuntimeStatus(userDataPath, result.runtime.id, {
        connectionMode: 'ssh',
        sshTargetId: ssh.targetId,
        runtimeEnvironmentId: ssh.environmentId
      })
      reestablishWokenServer(userDataPath, ssh.environmentId)
      return woken
    } catch (error) {
      failAfterResume(error)
      throw error
    }
  }
  return result.runtime
}

export const RECIPE_VM_UNREACHABLE_WITHOUT_RESUME_MESSAGE =
  "Orca hasn't reached this workspace's VM for several minutes, and its recipe has no resume " +
  'step to restart it. If the VM is gone, delete this workspace and create it again.'

/** A paired VM server Orca could not reach for minutes, that is not ready now and that the user
 *  did not disconnect. */
function isPairedServerContactLost(environmentId: string): boolean {
  return (
    isRuntimeEnvironmentContactLost(environmentId) &&
    !isRuntimeEnvironmentManuallyDisconnected(environmentId) &&
    getRemoteRuntimeSharedControlDiagnostics(environmentId)?.state !== 'ready'
  )
}

/** Nothing retried this server's control socket or health probe while its VM slept; reopen them.
 *  On the next turn, once this wake is no longer pending, so the reopen is not refused as waking. */
function reestablishWokenServer(userDataPath: string, environmentId: string): void {
  setTimeout(async () => {
    try {
      reconnectRemoteRuntimeSharedControlConnection(environmentId)
      void (await getRuntimeEnvironmentStatusOwner(userDataPath, environmentId))
        .refresh({ reconnect: true })
        .catch(() => {})
    } catch (error) {
      console.warn('[ephemeral-vm] reconnect after wake failed', error)
    }
  }, 0)
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
