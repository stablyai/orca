import { describe, expect, it } from 'vitest'
import { mapCodexRpcRateLimits } from './codex-rpc-rate-limit-mapper'

describe('mapCodexRpcRateLimits', () => {
  it('keeps the plan the app-server reports with usage', () => {
    const limits = mapCodexRpcRateLimits({
      rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 }, planType: 'pro' }
    })
    expect(limits.planType).toBe('pro')
  })
})
