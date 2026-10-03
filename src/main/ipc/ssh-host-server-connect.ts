/** The connect path's managed-server step: decide the host's server, and publish a managed connect. */
import { getAppEnvironment } from '../../shared/app-environment'
import type { SshConnectionState, SshTarget } from '../../shared/ssh-types'
import type { HostServerOnConnectResult } from '../ssh/ssh-host-server-on-connect'
import { setSshHostServerStatus } from '../ssh/ssh-host-server-status'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { broadcastSshState, getPublicSshState } from './ssh-renderer-broadcast'

/** Resolves null when the decision itself couldn't run; the caller then keeps today's relay path. */
export async function decideHostServer(
  target: SshTarget
): Promise<HostServerOnConnectResult | null> {
  try {
    // Why lazy: the managed-server graph (deploy, migration, tunnel) loads only when a host connects.
    const [{ resolveHostServerOnConnect }, { hostServerOnConnectDeps }] = await Promise.all([
      import('../ssh/ssh-host-server-on-connect'),
      import('./ssh-host-server-on-connect-wiring')
    ])
    return await resolveHostServerOnConnect(
      target,
      hostServerOnConnectDeps(getAppEnvironment().getPath('userData'))
    )
  } catch (error) {
    // A fenced host still refuses the relay below; any other host keeps today's relay path.
    console.warn('[ssh] Could not decide the managed Orca server for this host:', error)
    return null
  }
}

export function publishManagedServerConnect(
  targetId: string,
  environmentId: string
): SshConnectionState {
  const managedServer = { kind: 'managed' as const, environmentId }
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
