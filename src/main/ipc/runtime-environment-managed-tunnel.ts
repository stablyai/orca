import { resolveEnvironment } from '../../shared/runtime-environment-store'
import type {
  SshManagedServerStatus,
  SshManagedServerUpdateNote,
  SshTarget
} from '../../shared/ssh-types'
import { managedServerUpdateDeps } from '../ssh/managed-server-update-deps'
import { ensureOrcadManagedTunnel, rebuildOrcadManagedTunnel } from '../ssh/orcad-managed-tunnel'
import { verifyOrcadManagedServing } from '../ssh/orcad-managed-serving-verify'
import {
  MANAGED_ORCAD_NOT_ACTIVATED_DETAIL,
  setManagedOrcadStartListener,
  type OrcadManagedServing
} from '../ssh/orcad-managed-serving'
import {
  redeployStoppedManagedOrcad,
  updateManagedOrcadOnRestore
} from '../ssh/orcad-managed-update-on-restore'
import { getSshHostServerStatus, setSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { broadcastSshState } from './ssh-renderer-broadcast'

export async function resolveManagedRuntimeEnvironment(
  userDataPath: string,
  selector: string
): Promise<ReturnType<typeof resolveEnvironment>> {
  const environment = resolveEnvironment(userDataPath, selector)
  await ensureOrcadManagedTunnel(userDataPath, environment.id)
  // Why: a server that stopped (idle, killed, host rebooted) starts before the call that needs it.
  const serving = await verifyOrcadManagedServing(userDataPath, environment.id)
  const createDeps = () => ({
    ...managedServerUpdateDeps(userDataPath),
    target: () => {
      const targetId = environment.orcadDeployment?.sshTargetId
      return targetId ? (getSshTargetRegistryStore()?.getTarget(targetId) ?? null) : null
    },
    publish: publishRestoreUpdate
  })
  if (isStoppedElsewhere(serving)) {
    // Why awaited: this call needs the server, and another desktop's stop can land mid-session.
    if (await redeployStoppedManagedOrcad(environment.id, createDeps)) {
      // Why rebuild: the redeployed server may bind another port than the reused forward targets.
      await rebuildOrcadManagedTunnel(userDataPath, environment.id)
    }
  } else {
    // Why here: an auto-restored host may never see an SSH connect, so it would never update.
    void updateManagedOrcadOnRestore(environment.id, createDeps)
  }
  return resolveEnvironment(userDataPath, environment.id)
}

function isStoppedElsewhere(serving: OrcadManagedServing): boolean {
  return serving.state === 'unverifiable' && serving.detail === MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
}

function publishRestoreUpdate(
  target: SshTarget,
  environmentId: string,
  phase: 'updating' | 'settled',
  note?: SshManagedServerUpdateNote
): void {
  publishHostServerStatus(
    target.id,
    phase === 'updating'
      ? { kind: 'setting-up', phase: 'updating' }
      : { kind: 'managed', environmentId, ...(note ? { update: note } : {}) }
  )
}

/** Shows a managed server's start on the host's status line, wherever the start began. */
export function installManagedOrcadStartStatus(): void {
  setManagedOrcadStartListener({
    starting: (target) =>
      publishHostServerStatus(target.id, { kind: 'setting-up', phase: 'starting' }),
    settled: (target, environmentId, serving) =>
      publishHostServerStatus(target.id, {
        kind: 'managed',
        environmentId,
        ...(serving.state === 'unverifiable' ? { serving } : {})
      })
  })
}

/** A changed host the user resolved (moved or kept) is managed again; its status line says so now. */
export function publishResolvedChangedHostStatus(target: SshTarget, environmentId: string): void {
  setSshHostServerStatus(target.id, { kind: 'managed', environmentId })
  // Why a disconnected state too: the move released the relay session, which had the stale line.
  broadcastSshState(
    getCurrentMainWindow,
    target.id,
    connectionManager?.getState(target.id) ?? {
      targetId: target.id,
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0
    }
  )
}

export function publishHostServerStatus(targetId: string, status: SshManagedServerStatus): void {
  setSshHostServerStatus(targetId, status)
  // Only a host with a connection state has a status line to refresh.
  const state = connectionManager?.getState(targetId)
  if (state) {
    broadcastSshState(getCurrentMainWindow, targetId, { ...state, managedServer: status })
  }
}

/** A verified update supersedes the host's update and serving notes; any other host route is kept. */
export function clearManagedServerNotes(targetId: string, environmentId: string): void {
  const current = getSshHostServerStatus(targetId)
  if (current?.kind !== 'managed' || current.environmentId !== environmentId) {
    return
  }
  if (current.update || current.serving) {
    publishHostServerStatus(targetId, { kind: 'managed', environmentId })
  }
}
