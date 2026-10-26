import { getAppEnvironment } from '../../../shared/app-environment'
import type {
  SshConnectionState,
  SshManagedServerLinkedProject,
  SshManagedServerServingNote,
  SshManagedServerUpdateNote,
  SshTarget
} from '../../../shared/ssh-types'
import type { HostServerOnConnectResult } from '../../ssh/ssh-host-server-on-connect'
import { unservedHostServerMessage, unservedServerStatus } from '../../ssh/ssh-host-unserved-status'
import {
  clearSshHostServerStatus,
  getSshHostServerStatus,
  setSshHostServerStatus
} from '../../ssh/ssh-host-server-status'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { broadcastSshState, getPublicSshState } from './ssh-renderer-broadcast'
import { isAuthError } from '../../ssh/ssh-reconnect-error-classification'
import { isSshSessionStartFailure } from '../../ssh/ssh-session-start-failure'
import { describeSshConnectFailure } from '../../ssh/ssh-connect-failure-next-step'

export async function decideHostServer(target: SshTarget): Promise<HostServerOnConnectResult> {
  // Load managed-server deploy/migration/tunnel dependencies only when connecting.
  const [{ resolveHostServerOnConnect }, { hostServerOnConnectDeps }] = await Promise.all([
    import('../../ssh/ssh-host-server-on-connect'),
    import('./ssh-host-server-on-connect-wiring')
  ])
  return await resolveHostServerOnConnect(
    target,
    hostServerOnConnectDeps(getAppEnvironment().getPath('userData'))
  )
}

/** Rechecks a host another desktop's update held during this connect, until the fence clears. */
export function recheckWhenManagedFenceClears(target: SshTarget, environmentId: string): void {
  void Promise.all([
    import('../../ssh/managed-server-fence-recheck'),
    import('./ssh-host-server-on-connect-wiring')
  ]).then(([{ recheckFencedManagedServer, scheduleManagedServerFenceRecheck }, wiring]) => {
    const deps = wiring.hostServerOnConnectDeps(getAppEnvironment().getPath('userData'))
    scheduleManagedServerFenceRecheck(target.id, {
      stillCurrent: () => {
        const status = getSshHostServerStatus(target.id)
        return (
          connectionManager?.getState(target.id)?.status === 'connected' &&
          status?.kind === 'managed' &&
          status.environmentId === environmentId
        )
      },
      recheck: () => recheckFencedManagedServer(target, environmentId, deps),
      publish: (result) =>
        publishManagedServerConnect(target.id, environmentId, result.update, result.serving)
    })
  })
}

/** Failed server setup must leave connecting/setting-up state and publish the actionable error. */
export function publishHostServerDecisionFailure(targetId: string, error: unknown): void {
  const failure = error instanceof Error ? error : new Error(String(error))
  clearSshHostServerStatus(targetId)
  broadcastSshState(getCurrentMainWindow, targetId, {
    targetId,
    status: isAuthError(failure) ? 'auth-failed' : 'error',
    error: isSshSessionStartFailure(failure) ? describeSshConnectFailure(failure) : failure.message,
    reconnectAttempt: 0
  })
}

export function publishManagedServerConnect(
  targetId: string,
  environmentId: string,
  update?: SshManagedServerUpdateNote,
  serving?: SshManagedServerServingNote,
  linked?: SshManagedServerLinkedProject[]
): SshConnectionState {
  const managedServer = {
    kind: 'managed' as const,
    environmentId,
    ...(update ? { update } : {}),
    ...(serving ? { serving } : {}),
    ...(linked ? { linked } : {})
  }
  setSshHostServerStatus(targetId, managedServer)
  const state: SshConnectionState = {
    ...(connectionManager!.getState(targetId) ?? { targetId, reconnectAttempt: 0 }),
    targetId,
    status: 'connected',
    error: null,
    managedServer
  }
  broadcastSshState(getCurrentMainWindow, targetId, state)
  return getPublicSshState(targetId) ?? state
}

/**
 * COMPAT(legacy-relay-bridge): a host that can't move only because relay terminals run in it stays
 * connected, so the bridge keeps those terminals working in their tabs until they exit.
 */
export function publishBridgedUnservedHostServer(
  target: SshTarget,
  decision: Extract<HostServerOnConnectResult, { route: 'unserved' }>
): SshConnectionState {
  const managedServer = unservedServerStatus(decision)
  setSshHostServerStatus(target.id, managedServer)
  const state: SshConnectionState = {
    ...(connectionManager!.getState(target.id) ?? { targetId: target.id, reconnectAttempt: 0 }),
    targetId: target.id,
    status: 'connected',
    error: null,
    managedServer
  }
  broadcastSshState(getCurrentMainWindow, target.id, state)
  return getPublicSshState(target.id) ?? state
}

/** Publish the unserved status for renderer translation and fail the connect without a fallback. */
export function publishUnservedHostServer(
  target: SshTarget,
  decision: Extract<HostServerOnConnectResult, { route: 'unserved' }>
): Error {
  const managedServer = unservedServerStatus(decision)
  setSshHostServerStatus(target.id, managedServer)
  const failure = new Error(unservedHostServerMessage(decision))
  broadcastSshState(getCurrentMainWindow, target.id, {
    targetId: target.id,
    status: 'error',
    error: failure.message,
    reconnectAttempt: 0,
    managedServer
  })
  return failure
}
