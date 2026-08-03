import type { SshConnectionState } from '../../shared/ssh-types'

export function getPublicSshError(status: SshConnectionState['status']): string {
  return status === 'auth-failed' ? 'SSH authentication failed' : 'SSH connection unavailable'
}

export function getPublicSshState(state: SshConnectionState | null): SshConnectionState | null {
  return state ? { ...state, error: state.error ? getPublicSshError(state.status) : null } : null
}
