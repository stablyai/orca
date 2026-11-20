import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createClaudeAutoSwitch, pickAutoSwitchTarget } from './claude-auto-switch'

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

describe('createClaudeAutoSwitch', () => {
  const settings = {
    claudeAutoSwitch: { enabled: true, threshold: 90 },
    claudeAccountRotation: {},
    activeClaudeManagedAccountId: 'a',
    claudeManagedAccounts: ['a', 'b', 'c'].map((id) => ({ id, managedAuthRuntime: 'host' }))
  }
  const summary = (id: string, extra = {}) => ({ id, managedAuthRuntime: 'host', ...extra })
  const state = (over: Record<string, unknown> = {}) =>
    ({
      claude: {
        ...limits(95),
        usageMetadata: { readingAccount: { accountId: 'a', runtime: 'host', wslDistro: null } }
      },
      claudeTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [entry('b', 0), entry('c', 10)],
      ...over
    }) as never
  function setup(
    accounts: unknown[],
    select: (id: string) => Promise<unknown> = vi.fn((_id: string) => Promise.resolve())
  ) {
    let now = 1_000_000
    const run = createClaudeAutoSwitch({
      getSettings: () => settings as never,
      listAccounts: () => ({ accounts }) as never,
      select,
      now: () => now
    })
    return { run, select, advance: (ms: number) => (now += ms) }
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('switches to the best account on the host', async () => {
    const { run, select } = setup([summary('a'), summary('b'), summary('c')])
    run(state())
    await flush()
    expect(select).toHaveBeenCalledWith('b')
  })

  it('ignores a reading taken in WSL', async () => {
    const { run, select } = setup([summary('a'), summary('b')])
    run(state({ claudeTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' } }))
    await flush()
    expect(select).not.toHaveBeenCalled()
  })

  it('ignores a reading of another account', async () => {
    const { run, select } = setup([summary('a'), summary('b')])
    const other = {
      ...limits(95),
      usageMetadata: { readingAccount: { accountId: 'z', runtime: 'host', wslDistro: null } }
    }
    run(state({ claude: other }))
    await flush()
    expect(select).not.toHaveBeenCalled()
  })

  it('never picks an account that needs sign-in', async () => {
    const { run, select } = setup([summary('a'), summary('b', { needsSignIn: true }), summary('c')])
    run(state())
    await flush()
    expect(select).toHaveBeenCalledWith('c')
  })

  it('moves on to the next account after a failed switch', async () => {
    const select = vi.fn((id: string) =>
      id === 'b' ? Promise.reject(new Error('no login')) : Promise.resolve()
    )
    const { run, advance } = setup([summary('a'), summary('b'), summary('c')], select)
    run(state())
    await flush()
    advance(61_000)
    run(state())
    await flush()
    expect(select.mock.calls.map(([id]) => id)).toEqual(['b', 'c'])
  })

  it('waits out the cooldown even after a failure', async () => {
    const select = vi.fn(() => Promise.reject(new Error('no login')))
    const { run } = setup([summary('a'), summary('b'), summary('c')], select)
    run(state())
    await flush()
    run(state())
    await flush()
    expect(select).toHaveBeenCalledTimes(1)
  })
})
