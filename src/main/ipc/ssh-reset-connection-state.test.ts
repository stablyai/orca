import { afterEach, expect, it, vi } from 'vitest'
import { handleSshConnectionStateChange } from './ssh-connection-state-callbacks'
import { activeSessions } from './ssh-active-relay-sessions'
import { pendingTransportReconnects } from './ssh-connect-attempt-registry'
import { relayStateOverrides } from './ssh-renderer-broadcast'
import { getSshProviderAuthority } from '../ssh/ssh-provider-authority'
import type { SshRelaySession } from '../ssh/ssh-relay-session'
import type { SshConnectionState } from '../../shared/ssh-types'
import { isSshResetAdmissionBlocked } from './ssh-reset-production-state'

vi.mock('./ssh-reset-production-state', () => ({
  isSshResetAdmissionBlocked: vi.fn(() => false)
}))

vi.mock('./ssh-passphrase', () => ({ requestCredential: vi.fn() }))
vi.mock('./ssh-renderer-broadcast', () => ({
  broadcastSshState: vi.fn(),
  clearRelayStateOverride: vi.fn(),
  publishRelayOverride: vi.fn(),
  relayStateOverrides: new Map()
}))
import {
  broadcastSshState,
  clearRelayStateOverride,
  publishRelayOverride
} from './ssh-renderer-broadcast'

afterEach(() => {
  activeSessions.delete('reset-state-target')
  pendingTransportReconnects.delete('reset-state-target')
  relayStateOverrides.delete('reset-state-target')
  vi.clearAllMocks()
  vi.mocked(isSshResetAdmissionBlocked).mockReturnValue(false)
})

it.each(['connected', 'reconnecting', 'disconnected', 'auth-failed', 'error'] as const)(
  'does not reconnect, rotate authority or publish ordinary %s while reset owns transport loss',
  (status) => {
    const targetId = 'reset-state-target'
    const reconnect = vi.fn()
    activeSessions.set(targetId, {
      getState: () => 'ready',
      isResetRetirementPending: () => true,
      reconnect
    } as unknown as SshRelaySession)
    pendingTransportReconnects.add(targetId)
    const state: SshConnectionState = { targetId, status, reconnectAttempt: 0, error: null }
    relayStateOverrides.set(targetId, state)
    const authority = getSshProviderAuthority(targetId)
    handleSshConnectionStateChange(targetId, state)
    expect(getSshProviderAuthority(targetId)).toEqual(authority)
    expect(reconnect).not.toHaveBeenCalled()
    expect(pendingTransportReconnects.has(targetId)).toBe(true)
    expect(broadcastSshState).not.toHaveBeenCalled()
    expect(clearRelayStateOverride).not.toHaveBeenCalled()
    expect(publishRelayOverride).not.toHaveBeenCalled()
  }
)

it('retains reset admission after the captured session has been removed', () => {
  const targetId = 'reset-state-target'
  vi.mocked(isSshResetAdmissionBlocked).mockReturnValue(true)
  pendingTransportReconnects.add(targetId)
  handleSshConnectionStateChange(targetId, {
    targetId,
    status: 'connected',
    reconnectAttempt: 0,
    error: null
  })
  expect(pendingTransportReconnects.has(targetId)).toBe(true)
  expect(broadcastSshState).not.toHaveBeenCalled()
  expect(clearRelayStateOverride).not.toHaveBeenCalled()
})
