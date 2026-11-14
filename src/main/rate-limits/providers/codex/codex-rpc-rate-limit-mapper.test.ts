import { describe, expect, it } from 'vitest'
import { mapCodexRpcRateLimits } from './codex-rpc-rate-limit-mapper'

describe('mapCodexRpcRateLimits individualLimit', () => {
  it('shows the spend cap as the monthly window when no 5h/7d window is reported', () => {
    const limits = mapCodexRpcRateLimits({
      rateLimits: {
        primary: null,
        secondary: null,
        individualLimit: { remainingPercent: 80, resetsAt: 1_800_000_000 }
      }
    })

    expect(limits.session).toBeNull()
    expect(limits.weekly).toBeNull()
    expect(limits.monthly).toMatchObject({
      usedPercent: 20,
      windowMinutes: 43_200,
      resetsAt: 1_800_000_000_000
    })
  })

  it('keeps the 5h/7d windows and ignores the spend cap when they are reported', () => {
    const limits = mapCodexRpcRateLimits({
      rateLimits: {
        primary: { usedPercent: 40, windowDurationMins: 300 },
        secondary: { usedPercent: 10, windowDurationMins: 10080 },
        individualLimit: { remainingPercent: 80, resetsAt: 1_800_000_000 }
      }
    })

    expect(limits.session?.usedPercent).toBe(40)
    expect(limits.weekly?.usedPercent).toBe(10)
    expect(limits.monthly).toBeNull()
  })
})
