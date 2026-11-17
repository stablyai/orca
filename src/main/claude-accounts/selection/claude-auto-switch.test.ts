import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { pickAutoSwitchTarget } from './claude-auto-switch'

const limits = (used: number): ProviderRateLimits =>
  ({
    provider: 'claude',
    session: { usedPercent: used, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null
  }) as ProviderRateLimits
const entry = (accountId: string, used: number) => ({
  accountId,
  rateLimits: limits(used),
  updatedAt: 0,
  isFetching: false
})
const base = {
  activeId: 'a',
  accountIds: ['a', 'b', 'c'],
  rotation: {},
  defaultThreshold: 90
}

describe('pickAutoSwitchTarget', () => {
  it('stays below the threshold', () => {
    expect(
      pickAutoSwitchTarget({ ...base, active: limits(50), inactive: [entry('b', 0)] })
    ).toBeNull()
  })
  it('picks the account with the most quota left', () => {
    const inactive = [entry('b', 60), entry('c', 10)]
    expect(pickAutoSwitchTarget({ ...base, active: limits(95), inactive })).toBe('c')
  })
  it('skips disabled and exhausted accounts', () => {
    const inactive = [entry('b', 0), entry('c', 95)]
    const rotation = { b: { disabled: true } }
    expect(pickAutoSwitchTarget({ ...base, active: limits(95), inactive, rotation })).toBeNull()
  })
  it('prefers higher priority over more quota', () => {
    const inactive = [entry('b', 80), entry('c', 0)]
    const rotation = { b: { priority: 5 } }
    expect(pickAutoSwitchTarget({ ...base, active: limits(95), inactive, rotation })).toBe('b')
  })
  it('uses the per-account threshold', () => {
    const rotation = { a: { threshold: 60 } }
    expect(
      pickAutoSwitchTarget({ ...base, active: limits(65), inactive: [entry('b', 0)], rotation })
    ).toBe('b')
  })
})
