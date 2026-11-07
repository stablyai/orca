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
})
