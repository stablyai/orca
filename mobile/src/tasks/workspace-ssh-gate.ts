import type { SshConnectionState, SshConnectionStatus } from '../../../src/shared/ssh-types'
import { t } from '@/i18n/mobile-i18n'

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
    return t('workspaceSshGate.connected')
  }
  if (status === 'connecting') {
    return t('workspaceSshGate.connecting')
  }
  if (status === 'deploying-relay') {
    return t('workspaceSshGate.deploying')
  }
  if (status === 'reconnecting') {
    return t('workspaceSshGate.reconnecting')
  }
  if (status === 'auth-failed') {
    return t('workspaceSshGate.authentication')
  }
  if (status === 'reconnection-failed') {
    return t('workspaceSshGate.reconnect')
  }
  if (status === 'error') {
    return t('workspaceSshGate.connection')
  }
  return t('workspaceSshGate.disconnected')
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
