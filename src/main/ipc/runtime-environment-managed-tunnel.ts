import { resolveEnvironment } from '../../shared/runtime-environment-store'
import type {
  SshManagedServerStatus,
  SshManagedServerUpdateNote,
  SshTarget
} from '../../shared/ssh-types'
import { managedServerUpdateDeps } from '../ssh/managed-server-update-deps'
import { ensureOrcadManagedTunnel } from '../ssh/orcad-managed-tunnel'
import { verifyOrcadManagedServing } from '../ssh/orcad-managed-serving-verify'
import { setManagedOrcadStartListener } from '../ssh/orcad-managed-serving'
import { updateManagedOrcadOnRestore } from '../ssh/orcad-managed-update-on-restore'
import { setSshHostServerStatus } from '../ssh/ssh-host-server-status'
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
  await verifyOrcadManagedServing(userDataPath, environment.id)
  // Why here: an auto-restored host may never see an SSH connect, so it would never update.
  void updateManagedOrcadOnRestore(environment.id, () => ({
    ...managedServerUpdateDeps(userDataPath),
    target: () => {
      const targetId = environment.orcadDeployment?.sshTargetId
      return targetId ? (getSshTargetRegistryStore()?.getTarget(targetId) ?? null) : null
    },
    publish: publishRestoreUpdate
  }))
  return resolveEnvironment(userDataPath, environment.id)
}

function publishRestoreUpdate(
  target: SshTarget,
  environmentId: string,
  phase: 'updating' | 'settled',
  note?: SshManagedServerUpdateNote
): void {
  publishHostServerStatus(
    target,
    phase === 'updating'
      ? { kind: 'setting-up', phase: 'updating' }
      : { kind: 'managed', environmentId, ...(note ? { update: note } : {}) }
  )
}

/** Shows a managed server's start on the host's status line, wherever the start began. */
export function installManagedOrcadStartStatus(): void {
  setManagedOrcadStartListener({
    starting: (target) =>
      publishHostServerStatus(target, { kind: 'setting-up', phase: 'starting' }),
    settled: (target, environmentId, serving) =>
      publishHostServerStatus(target, {
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

function publishHostServerStatus(target: SshTarget, status: SshManagedServerStatus): void {
  setSshHostServerStatus(target.id, status)
  // Only a host with a connection state has a status line to refresh.
  const state = connectionManager?.getState(target.id)
  if (state) {
    broadcastSshState(getCurrentMainWindow, target.id, state)
  }
}
