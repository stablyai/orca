import { describe, expect, it, vi } from 'vitest'
import { mobileRelayMintFailureFromUnknown } from '../../../shared/mobile-relay-mint-failure'
import { RelayControlRequests } from './relay-control-requests'

// Anchored relay_* classification rejects diagnostic suffixes; keep timeout codes precise end to end (STA-7672).
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
