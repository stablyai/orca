import { describe, expect, it, vi } from 'vitest'
import { mobileRelayMintFailureFromUnknown } from '../../../shared/mobile-relay-mint-failure'
import { RelayControlRequests } from './relay-control-requests'

// A control-request rejection is a classification key, not prose: the pairing
// flow feeds error.message through an anchored /^relay_[a-z0-9_]{1,74}$/ and
// falls back to a generic code on any mismatch. Appending diagnostics to that
// message once turned every pairing timeout into relay_mint_failed, losing the
// one signal that identified STA-7672 — so pin the contract end to end.
describe('control request timeout classification', () => {
  it('keeps a timed-out request classifiable by the mobile pairing flow', async () => {
    vi.useFakeTimers()
    try {
      const onTimeout = vi.fn()
      const requests = new RelayControlRequests(undefined, onTimeout)
      const settled = requests.createInvite('req-1', 'device-1', () => {}).catch((e: Error) => e)

      await vi.advanceTimersByTimeAsync(10_000)
      const error = await settled

      expect(onTimeout).toHaveBeenCalledOnce()
      expect(
        mobileRelayMintFailureFromUnknown({
          error,
          stage: 'create_pairing_relay',
          fallbackCode: 'relay_mint_failed',
          fallbackMessage: 'could not mint'
        }).code
      ).toBe('relay_control_request_timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})
