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
    return t('m.GyhUU1I')
  }
  if (status === 'connecting') {
    return t('m.Y4pY3mY')
  }
  if (status === 'deploying-relay') {
    return t('m.XpcB6Lk')
  }
  if (status === 'reconnecting') {
    return t('m.uEprraQ')
  }
  if (status === 'auth-failed') {
    return t('m.55lbvEs')
  }
  if (status === 'reconnection-failed') {
    return t('m.wOY1nLM')
  }
  if (status === 'error') {
    return t('m.FZM-PD0')
  }
  return t('m.7wOLCCY')
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
