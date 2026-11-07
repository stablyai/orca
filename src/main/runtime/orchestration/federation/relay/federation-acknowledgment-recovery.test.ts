import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FederationAcknowledgmentRecovery } from './federation-acknowledgment-recovery'

describe('FederationAcknowledgmentRecovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('backs off a failing row without holding back healthy acknowledgment debt', async () => {
    const pending = [
      { dispatchId: 'unreachable', rowId: 1 },
      { dispatchId: 'healthy', rowId: 2 }
    ]
    const attempts: { dispatchId: string; at: number }[] = []
    const recovery = new FederationAcknowledgmentRecovery({
      findNextAfter: (afterRowId) => pending.find((row) => row.rowId > afterRowId),
      acknowledgedThrough: () => 0,
      sync: async (dispatchId) => {
        attempts.push({ dispatchId, at: Date.now() })
        if (dispatchId === 'unreachable') {
          throw new Error('Unknown environment')
        }
        pending.splice(
          pending.findIndex((row) => row.dispatchId === dispatchId),
          1
        )
      }
    })

    recovery.ensure()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(attempts.find((attempt) => attempt.dispatchId === 'healthy')?.at).toBe(1_000)
    expect(
      attempts.filter((attempt) => attempt.dispatchId === 'unreachable').map(({ at }) => at)
    ).toEqual([0, 2_000, 6_000])
    recovery.reset()
  })

  it('backs off a row whose sync succeeds without settling it, and settles it once the host can', async () => {
    const pending = [{ dispatchId: 'awaiting-settlement', rowId: 1 }]
    let hostCanSettle = false
    const attempts: number[] = []
    const recovery = new FederationAcknowledgmentRecovery({
      findNextAfter: (afterRowId) => pending.find((row) => row.rowId > afterRowId),
      acknowledgedThrough: () => 0,
      sync: async () => {
        attempts.push(Date.now())
        if (hostCanSettle) {
          pending.length = 0
        }
      }
    })

    recovery.ensure()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(attempts).toEqual([0, 2_000, 6_000])

    hostCanSettle = true
    await vi.advanceTimersByTimeAsync(10_000)
    expect(attempts).toEqual([0, 2_000, 6_000, 14_000])
    expect(pending).toHaveLength(0)
    recovery.reset()
  })

  it('keeps the base cadence while a large backlog acknowledges a few pages per sync', async () => {
    const pending = [{ dispatchId: 'backlog', rowId: 1 }]
    let acknowledged = 0
    const attempts: number[] = []
    const recovery = new FederationAcknowledgmentRecovery({
      findNextAfter: (afterRowId) => pending.find((row) => row.rowId > afterRowId),
      acknowledgedThrough: () => acknowledged,
      sync: async () => {
        attempts.push(Date.now())
        acknowledged = Math.min(acknowledged + 300, 700)
        if (acknowledged === 700) {
          pending.length = 0
        }
      }
    })

    recovery.ensure()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(attempts).toEqual([0, 1_000, 2_000])
    expect(pending).toHaveLength(0)
    recovery.reset()
  })
})
