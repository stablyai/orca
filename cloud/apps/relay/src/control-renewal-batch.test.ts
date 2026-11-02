import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONTROL_RENEWAL_BATCH_INTERVAL_MS,
  CONTROL_RENEWAL_BATCH_MAX_ROWS,
  ControlRenewalBatch,
  type ControlRenewalFlush
} from './control-renewal-batch.js'
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

  it('spends one call on every renewal that came due in the window', async () => {
    const renew = vi.fn(async (rows: readonly ControlRenewalRequest[]) =>
      rows.map((): ControlRenewalOutcome => 'renewed')
    )
    const batch = new ControlRenewalBatch(renew)
    const settled = [
      batch.enqueue(request('host0000000000a1')),
      batch.enqueue(request('host0000000000a2')),
      batch.enqueue(request('host0000000000a3'))
    ]

    expect(renew).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(CONTROL_RENEWAL_BATCH_INTERVAL_MS)
    await expect(Promise.all(settled)).resolves.toEqual([undefined, undefined, undefined])
    expect(renew).toHaveBeenCalledOnce()
    expect(renew.mock.calls[0]![0].map((row) => row.identity.relayHostId)).toEqual([
      'host0000000000a1',
      'host0000000000a2',
      'host0000000000a3'
    ])
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

  it('flushes on reaching the row ceiling instead of waiting out the window', async () => {
    const renew = vi.fn(async (rows: readonly ControlRenewalRequest[]) =>
      rows.map((): ControlRenewalOutcome => 'renewed')
    )
    const batch = new ControlRenewalBatch(renew)
    for (let row = 0; row < CONTROL_RENEWAL_BATCH_MAX_ROWS - 1; row++) {
      void batch.enqueue(request(`host${String(row).padStart(12, '0')}`))
    }
    expect(renew).not.toHaveBeenCalled()

    void batch.enqueue(request('host0000000000zz'))
    await vi.advanceTimersByTimeAsync(0)

    expect(renew).toHaveBeenCalledOnce()
    expect(renew.mock.calls[0]![0]).toHaveLength(CONTROL_RENEWAL_BATCH_MAX_ROWS)
    // The window timer must not fire a second, empty statement.
    await vi.advanceTimersByTimeAsync(CONTROL_RENEWAL_BATCH_INTERVAL_MS)
    expect(renew).toHaveBeenCalledOnce()
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

  it('reports the driver failure to every caller in the flush', async () => {
    const batch = new ControlRenewalBatch(async () => {
      throw new Error('pool timeout')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const first = outcomeOf(batch.enqueue(request('host0000000000d1')))
      const second = outcomeOf(batch.enqueue(request('host0000000000d2')))
      await vi.advanceTimersByTimeAsync(CONTROL_RENEWAL_BATCH_INTERVAL_MS)

      await expect(Promise.all([first, second])).resolves.toEqual([
        'pool timeout',
        'pool timeout'
      ])
    } finally {
      warn.mockRestore()
    }
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

  it('stays quiet for a fast flush that renewed everything', async () => {
    const flushes: ControlRenewalFlush[] = []
    const batch = new ControlRenewalBatch(
      async () => ['renewed'],
      () => ({ cellId: 'cell-a' }),
      (flush) => flushes.push(flush)
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      void batch.enqueue(request('host0000000000f1'))
      await vi.advanceTimersByTimeAsync(CONTROL_RENEWAL_BATCH_INTERVAL_MS)

      expect(warn).not.toHaveBeenCalled()
      expect(flushes).toEqual([
        { rows: 1, durationMs: expect.any(Number), outcomes: { renewed: 1 } }
      ])
    } finally {
      warn.mockRestore()
    }
  })

  it('logs one line with the outcome counts when a flush did not renew everything', async () => {
    const batch = new ControlRenewalBatch(
      async () => ['renewed', 'control_activity_not_found'],
      () => ({ cellId: 'cell-a' })
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      void outcomeOf(batch.enqueue(request('host0000000000g1')))
      const missing = outcomeOf(batch.enqueue(request('host0000000000g2')))
      await vi.advanceTimersByTimeAsync(CONTROL_RENEWAL_BATCH_INTERVAL_MS)
      await expect(missing).resolves.toBe('control_activity_not_found')

      expect(warn).toHaveBeenCalledOnce()
      expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({
        event: 'orca_relay_control_renewal_flush',
        cellId: 'cell-a',
        rows: 2,
        outcomes: { renewed: 1, control_activity_not_found: 1 }
      })
    } finally {
      warn.mockRestore()
    }
  })
})
