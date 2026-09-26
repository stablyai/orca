import { describe, expect, it } from 'vitest'
import { RELAY_HOST_CLOSE_REASON } from '../../../shared/relay-host-close-reason'
import { relayOfflineReasonMintFailureCode } from './relay-offline-reason'

describe('relayOfflineReasonMintFailureCode', () => {
  it('maps each known reason to its own mint-failure code', () => {
    expect(relayOfflineReasonMintFailureCode(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)).toBe(
      'relay_signed_out'
    )
    expect(relayOfflineReasonMintFailureCode('not_entitled')).toBe('relay_not_entitled')
    expect(relayOfflineReasonMintFailureCode('broker_unavailable')).toBe('relay_broker_unavailable')
    expect(relayOfflineReasonMintFailureCode('broker_rejected')).toBe('relay_broker_rejected')
    expect(relayOfflineReasonMintFailureCode('auth_unavailable')).toBe('relay_auth_unavailable')
  })

  it('falls back to relay_control_not_active when no reason is known', () => {
    expect(relayOfflineReasonMintFailureCode(null)).toBe('relay_control_not_active')
  })
})
