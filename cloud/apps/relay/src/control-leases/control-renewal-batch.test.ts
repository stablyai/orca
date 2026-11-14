import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_RENEWAL_BATCH_INTERVAL_MS, ControlRenewalBatch } from './control-renewal-batch.js'
import type {
  ControlRenewalOutcome,
  ControlRenewalRequest
} from './control-renewal-statement.js'

function request(host: string): ControlRenewalRequest {
  return {
    identity: { userId: 'user-a', relayHostId: host },
    activityId: 'control:cell-a:1',
    cellId: 'cell-a',
    expiresAt: 1_000
  }
}

describe('control renewal batch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('lets the next renewal finish while an earlier flush is blocked', async () => {
    let release!: (outcomes: ControlRenewalOutcome[]) => void
    const renew = vi
      .fn<(rows: readonly ControlRenewalRequest[]) => Promise<ControlRenewalOutcome[]>>()
      .mockImplementationOnce(
        async () => await new Promise<ControlRenewalOutcome[]>((resolve) => (release = resolve))
      )
      .mockResolvedValue(['renewed'])
    const batch = new ControlRenewalBatch(renew)
    const stalled = batch.enqueue(request('host0000000000c1'))
    await vi.advanceTimersByTimeAsync(CONTROL_RENEWAL_BATCH_INTERVAL_MS)

    const next = batch.enqueue(request('host0000000000c2'))
    await vi.advanceTimersByTimeAsync(CONTROL_RENEWAL_BATCH_INTERVAL_MS)

    await expect(next).resolves.toBeUndefined()
    release(['renewed'])
    await expect(stalled).resolves.toBeUndefined()
  })

})
