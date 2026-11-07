import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_RENEWAL_BATCH_INTERVAL_MS, ControlRenewalBatch } from './control-renewal-batch.js'
import type {
  ControlRenewalOutcome,
  ControlRenewalRequest
} from './control-renewal-statement.js'

// Settles into the outcome the caller saw, attached at enqueue so a rejection is
// never momentarily unhandled.
function outcomeOf(renewal: Promise<void>): Promise<string> {
  return renewal.then(
    () => 'renewed',
    (error: unknown) => String((error as { message?: unknown }).message)
  )
}

function request(
  host: string,
  expiresAt = 1_000,
  activityId = 'control:cell-a:1'
): ControlRenewalRequest {
  return {
    identity: { userId: 'user-a', relayHostId: host },
    activityId,
    cellId: 'cell-a',
    expiresAt
  }
}

describe('control renewal batch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('routes each outcome back to the caller that asked for it', async () => {
    const outcomes: ControlRenewalOutcome[] = [
      'renewed',
      'assignment_not_found',
      'control_activity_moved'
    ]
    const batch = new ControlRenewalBatch(async () => outcomes)
    const first = outcomeOf(batch.enqueue(request('host0000000000b1')))
    const second = outcomeOf(batch.enqueue(request('host0000000000b2')))
    const third = outcomeOf(batch.enqueue(request('host0000000000b3')))

    await vi.advanceTimersByTimeAsync(CONTROL_RENEWAL_BATCH_INTERVAL_MS)

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      'renewed',
      'assignment_not_found',
      'control_activity_moved'
    ])
  })

  it('does not hold a new window behind a statement still in PostgreSQL', async () => {
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

    expect(renew).toHaveBeenCalledTimes(2)
    await expect(next).resolves.toBeUndefined()
    release(['renewed'])
    await expect(stalled).resolves.toBeUndefined()
  })

  it('supersedes a second attempt for one lease and answers both callers', async () => {
    const renew = vi.fn(async (rows: readonly ControlRenewalRequest[]) =>
      rows.map((): ControlRenewalOutcome => 'renewed')
    )
    const batch = new ControlRenewalBatch(renew)
    const earlier = batch.enqueue(request('host0000000000e1', 1_000))
    const later = batch.enqueue(request('host0000000000e1', 2_000))

    await vi.advanceTimersByTimeAsync(CONTROL_RENEWAL_BATCH_INTERVAL_MS)

    expect(renew.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ expiresAt: 2_000 })
    ])
    await expect(earlier).resolves.toBeUndefined()
    await expect(later).resolves.toBeUndefined()
  })

  it('holds a second activity for one host back to the next flush', async () => {
    const renew = vi.fn(async (rows: readonly ControlRenewalRequest[]) =>
      rows.map((): ControlRenewalOutcome => 'renewed')
    )
    const batch = new ControlRenewalBatch(renew)
    const first = batch.enqueue(request('host0000000000h1', 1_000, 'control:cell-a:1'))
    const second = batch.enqueue(request('host0000000000h1', 1_000, 'control:cell-a:2'))
    const other = batch.enqueue(request('host0000000000h2'))

    await vi.advanceTimersByTimeAsync(CONTROL_RENEWAL_BATCH_INTERVAL_MS)

    // One statement updates a host's assignment row once, so the host appears in
    // one flush only; the newer generation leads the next one.
    expect(renew.mock.calls[0]![0].map((row) => row.activityId)).toEqual([
      'control:cell-a:1',
      'control:cell-a:1'
    ])
    await expect(Promise.all([first, other])).resolves.toEqual([undefined, undefined])

    await vi.advanceTimersByTimeAsync(CONTROL_RENEWAL_BATCH_INTERVAL_MS)

    expect(renew).toHaveBeenCalledTimes(2)
    expect(renew.mock.calls[1]![0].map((row) => row.activityId)).toEqual(['control:cell-a:2'])
    await expect(second).resolves.toBeUndefined()
  })

})
