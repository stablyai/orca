/** The connect path's managed-server step: decide the host's server, and publish a managed connect. */
import { getAppEnvironment } from '../../shared/app-environment'
import type {
  SshConnectionState,
  SshManagedServerServingNote,
  SshManagedServerUpdateNote,
  SshTarget
} from '../../shared/ssh-types'
import type { HostServerOnConnectResult } from '../ssh/ssh-host-server-on-connect'
import { unservedHostServerMessage, unservedServerStatus } from '../ssh/ssh-host-unserved-status'
import {
  clearSshHostServerStatus,
  getSshHostServerStatus,
  setSshHostServerStatus
} from '../ssh/ssh-host-server-status'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { broadcastSshState, getPublicSshState } from './ssh-renderer-broadcast'
import { isAuthError } from '../ssh/ssh-connection-utils'

export async function decideHostServer(target: SshTarget): Promise<HostServerOnConnectResult> {
  // Why lazy: the managed-server graph (deploy, migration, tunnel) loads only when a host connects.
  const [{ resolveHostServerOnConnect }, { hostServerOnConnectDeps }] = await Promise.all([
    import('../ssh/ssh-host-server-on-connect'),
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
    import('../ssh/managed-server-fence-recheck'),
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

/**
 * A host only its managed server reaches failed to set up: leave 'connecting' and the 'setting
 * up' status for the error, as a failed transport connect does.
 */
export function publishHostServerDecisionFailure(targetId: string, error: unknown): void {
  const failure = error instanceof Error ? error : new Error(String(error))
  clearSshHostServerStatus(targetId)
  broadcastSshState(getCurrentMainWindow, targetId, {
    targetId,
    status: isAuthError(failure) ? 'auth-failed' : 'error',
    error: failure.message,
    reconnectAttempt: 0
  })
}

export function publishManagedServerConnect(
  targetId: string,
  environmentId: string,
  update?: SshManagedServerUpdateNote,
  serving?: SshManagedServerServingNote
): SshConnectionState {
  const managedServer = {
    kind: 'managed' as const,
    environmentId,
    ...(update ? { update } : {}),
    ...(serving ? { serving } : {})
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
 * A host the managed server doesn't serve: publish why and fail the connect. There is no fallback;
 * the renderer translates the status, and this message is only its untranslated twin.
 */
export function publishUnservedHostServer(
  target: SshTarget,
  decision: Extract<HostServerOnConnectResult, { route: 'relay' }>
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
