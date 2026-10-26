import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import {
  getOrcadSshDeployment,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { classifyRuntimeEnvironmentHost } from '../../../shared/runtime-environment-host-kind'
import type {
  SshManagedServerStatus,
  SshManagedServerUpdateNote,
  SshTarget
} from '../../../shared/ssh-types'
import { managedServerUpdateDeps } from '../../ssh/managed-server-update-deps'
import {
  ensureOrcadManagedTunnel,
  rebuildOrcadManagedTunnel
} from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { verifyOrcadManagedServing } from '../../managed-server/lifecycle/orcad-managed-serving-verify'
import {
  MANAGED_ORCAD_NOT_ACTIVATED_DETAIL,
  setManagedOrcadStartListener,
  type OrcadManagedServing
} from '../../managed-server/lifecycle/orcad-managed-serving'
import {
  redeployStoppedManagedOrcad,
  updateManagedOrcadOnRestore
} from '../../managed-server/lifecycle/orcad-managed-update-on-restore'
import { getSshHostServerStatus, setSshHostServerStatus } from '../../ssh/ssh-host-server-status'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { connectionManager, getCurrentMainWindow } from '../ssh/ssh-ipc-context'
import { getWslHostService } from '../../wsl/wsl-host-service-instance'
import { assertWslHostReachable } from '../../wsl/wsl-host-gate'
import { broadcastSshState } from '../ssh/ssh-renderer-broadcast'
import { restoreManagedHostPortForwards } from '../ssh/ssh-managed-port-forward-restore'

export async function resolveManagedRuntimeEnvironment(
  userDataPath: string,
  selector: string
): Promise<ReturnType<typeof resolveEnvironment>> {
  const environment = resolveEnvironment(userDataPath, selector)
  // Enforce the WSL gate for calls, subscriptions and status probes.
  assertWslHostReachable(environment)
  const host = classifyRuntimeEnvironmentHost(environment)
  switch (host.kind) {
    case 'wsl':
      // Reached over the wsl.exe bridge; connects only when an open project or terminal needs it.
      await getWslHostService()?.ensureForRuntimeCall(environment.id)
      break
    case 'network':
      await prepareNetworkServerForCall(userDataPath, environment)
      break
  }
  return resolveEnvironment(userDataPath, environment.id)
}

async function prepareNetworkServerForCall(
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): Promise<void> {
  await ensureOrcadManagedTunnel(userDataPath, environment.id)
  restoreForwardsOverTunnel(environment)
  // Calls must restart managed servers stopped by idle timeout, kill or host reboot.
  const serving = await verifyOrcadManagedServing(userDataPath, environment.id)
  const createDeps = () => ({
    ...managedServerUpdateDeps(userDataPath),
    target: () => {
      const targetId = getOrcadSshDeployment(environment)?.sshTargetId
      return targetId ? (getSshTargetRegistryStore()?.getTarget(targetId) ?? null) : null
    },
    publish: publishRestoreUpdate
  })
  if (isStoppedElsewhere(serving)) {
    // Await redeployment: another desktop can stop the server mid-session.
    if (await redeployStoppedManagedOrcad(environment.id, createDeps)) {
      const targetId = getOrcadSshDeployment(environment)?.sshTargetId
      if (targetId) {
        await forgetLaunchSessionVerdictLazily(targetId)
      }
      // Redeployment may change the server port behind the existing forward.
      await rebuildOrcadManagedTunnel(userDataPath, environment.id)
    }
  } else {
    // Auto-restored hosts may never get an SSH connect to trigger their update.
    const update = updateManagedOrcadOnRestore(environment.id, createDeps)
    const targetId = getOrcadSshDeployment(environment)?.sshTargetId
    if (targetId) {
      // Publish the warning after update status settles; import lazily to break the publishing cycle.
      void Promise.resolve(update)
        .then(() => import('../ssh/ssh-host-launch-session-note'))
        .then(({ noteEndedLaunchSshSession }) =>
          noteEndedLaunchSshSession(targetId, environment.id)
        )
        .catch(() => {})
    }
  }
}

// The tunnel proves the host served even when no update check or start publishes its status (#32484).
function restoreForwardsOverTunnel(environment: KnownRuntimeEnvironment): void {
  const targetId = getOrcadSshDeployment(environment)?.sshTargetId
  if (targetId) {
    void restoreManagedHostPortForwards(targetId, { tunnelUp: true })
  }
}

async function forgetLaunchSessionVerdictLazily(targetId: string): Promise<void> {
  // Import lazily because the note module publishes through this module.
  const { forgetLaunchSessionVerdict } = await import('../ssh/ssh-host-launch-session-note')
  forgetLaunchSessionVerdict(targetId)
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

export function installManagedOrcadStartStatus(): void {
  setManagedOrcadStartListener({
    starting: (target) =>
      publishHostServerStatus(target.id, { kind: 'setting-up', phase: 'starting' }),
    settled: (target, environmentId, serving) => {
      if (serving.state === 'started') {
        void forgetLaunchSessionVerdictLazily(target.id).catch(() => {})
      }
      publishHostServerStatus(target.id, {
        kind: 'managed',
        environmentId,
        ...(serving.state === 'unverifiable' ? { serving } : {})
      })
    }
  })
}

export function publishResolvedChangedHostStatus(target: SshTarget, environmentId: string): void {
  setSshHostServerStatus(target.id, { kind: 'managed', environmentId })
  // Moves release the relay session; publish even when its stale status line is disconnected.
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

/** Clear update/serving notes for this verified server while preserving other host routes. */
export function clearManagedServerNotes(targetId: string, environmentId: string): void {
  const current = getSshHostServerStatus(targetId)
  if (current?.kind !== 'managed' || current.environmentId !== environmentId) {
    return
  }
  if (current.update || current.serving) {
    // Updates can preserve the daemon; clearing its warning requires a verified restart.
    publishHostServerStatus(targetId, {
      kind: 'managed',
      environmentId,
      ...(current.launchSessionEnded ? { launchSessionEnded: true as const } : {})
    })
  }
}

/** A restart that verified a fresh daemon and a live launching session clears the warning. */
export function clearLaunchSessionNote(targetId: string, environmentId: string): void {
  const current = getSshHostServerStatus(targetId)
  if (current?.kind === 'managed' && current.environmentId === environmentId) {
    const { launchSessionEnded: _cleared, ...rest } = current
    publishHostServerStatus(targetId, rest)
  }
}
