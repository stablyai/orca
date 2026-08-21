import { describe, expect, it } from 'vitest'
import type { SshConnectionState, SshProviderEpoch } from '../../shared/ssh-types'
import { getPublicSshState } from './public-ssh-state'

describe('public SSH state', () => {
  it('preserves the complete provider authority pair', () => {
    const state: SshConnectionState = {
      targetId: 'ssh-a',
      status: 'error',
      error: 'private detail',
      reconnectAttempt: 0,
      providerEpoch: 'provider-a' as SshProviderEpoch,
      connectionGeneration: 3
    }

    expect(getPublicSshState(state)).toEqual({
      ...state,
      error: 'SSH connection unavailable'
    })
  })
})
