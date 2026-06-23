import type { SshConnectionState, SshConnectionStatus } from '../../../src/shared/ssh-types'

export type WorkspaceSshGate = {
  status: SshConnectionStatus | null
  requiresConnection: boolean
  connectInProgress: boolean
  error: string | null
}

function isWorkspaceSshConnectInProgress(status: SshConnectionStatus | null): boolean {
  return status === 'connecting' || status === 'deploying-relay' || status === 'reconnecting'
}

export function workspaceSshStatusLabel(status: SshConnectionStatus | null): string {
  if (status === 'connected') {
    return 'Connected'
  }
  if (status === 'connecting') {
    return 'Connecting'
  }
  if (status === 'deploying-relay') {
    return 'Deploying relay'
  }
  if (status === 'reconnecting') {
    return 'Reconnecting'
  }
  if (status === 'auth-failed') {
    return 'Authentication failed'
  }
  if (status === 'reconnection-failed') {
    return 'Reconnect failed'
  }
  if (status === 'error') {
    return 'Connection failed'
  }
  return 'Disconnected'
}

export function deriveWorkspaceSshGate(args: {
  connectionId: string | null
  state: SshConnectionState | null
  connecting: boolean
}): WorkspaceSshGate {
  const matchingState =
    args.connectionId && args.state?.targetId === args.connectionId ? args.state : null
  const status = matchingState?.status ?? null
  return {
    status,
    requiresConnection: args.connectionId !== null && status !== 'connected',
    connectInProgress: args.connecting || isWorkspaceSshConnectInProgress(status),
    error: matchingState?.error ?? null
  }
}
