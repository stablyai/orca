import type { SshConnectionState, SshConnectionStatus } from '../../../src/shared/ssh-types'
import { ORCAD_RECLAIM_STALE_LOCK_FLAG } from '../../../src/shared/orcad-stale-lock-reclaim'
import { translate } from '../i18n/mobile-i18n'

// Keep unread SSH fields optional so an omitted member cannot drop auth-failed state into connected fallback.
export type WorkspaceSshRecord = Omit<
  SshConnectionState,
  'error' | 'reconnectAttempt' | 'managedServer'
> & {
  error?: string | null
  reconnectAttempt?: number
  managedServer?: { kind?: string; serving?: { state?: string; detail?: string } }
}

export type WorkspaceSshGate = {
  status: SshConnectionStatus | null
  requiresConnection: boolean
  connectInProgress: boolean
  error: string | null
  needsDesktopServerRecovery: boolean
}

function isWorkspaceSshConnectInProgress(status: SshConnectionStatus | null): boolean {
  return status === 'connecting' || status === 'deploying-relay' || status === 'reconnecting'
}

export function workspaceSshStatusLabel(status: SshConnectionStatus | null): string {
  if (status === 'connected') {
    return translate('tasks.workspaceSshGate.connected', 'Connected')
  }
  if (status === 'connecting') {
    return translate('tasks.workspaceSshGate.connecting', 'Connecting')
  }
  if (status === 'deploying-relay') {
    return translate('tasks.workspaceSshGate.deployingRelay', 'Deploying relay')
  }
  if (status === 'reconnecting') {
    return translate('tasks.workspaceSshGate.reconnecting', 'Reconnecting')
  }
  if (status === 'auth-failed') {
    return translate('tasks.workspaceSshGate.authenticationFailed', 'Authentication failed')
  }
  if (status === 'reconnection-failed') {
    return translate('tasks.workspaceSshGate.reconnectFailed', 'Reconnect failed')
  }
  if (status === 'error') {
    return translate('tasks.workspaceSshGate.connectionFailed', 'Connection failed')
  }
  return translate('tasks.workspaceSshGate.disconnected', 'Disconnected')
}

export function deriveWorkspaceSshGate(args: {
  connectionId: string | null
  state: WorkspaceSshRecord | null
  connecting: boolean
}): WorkspaceSshGate {
  const matchingState =
    args.connectionId && args.state?.targetId === args.connectionId ? args.state : null
  const status = matchingState?.status ?? null
  return {
    status,
    requiresConnection: args.connectionId !== null && status !== 'connected',
    connectInProgress: args.connecting || isWorkspaceSshConnectInProgress(status),
    error: matchingState?.error ?? null,
    needsDesktopServerRecovery: needsDesktopServerRecovery(matchingState?.managedServer)
  }
}

function needsDesktopServerRecovery(server: WorkspaceSshRecord['managedServer']): boolean {
  return (
    server?.kind === 'managed' &&
    server.serving?.state === 'unverifiable' &&
    Boolean(server.serving.detail?.includes(ORCAD_RECLAIM_STALE_LOCK_FLAG))
  )
}
