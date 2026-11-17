import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../../shared/agent-accounts/managed-account-types'
import { createEmptyRateLimitState } from '../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import type {
  ProviderRateLimits,
  RateLimitState,
  RateLimitWindow
} from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  nextClaudeAccountAfterUsageLimit,
  startClaudeUsageLimitAccountSwitch
} from './claude-usage-limit-account-switch'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

function window(
  usedPercent: number,
  resetsInHours: number,
  windowMinutes = 10080
): RateLimitWindow {
  return {
    usedPercent,
    windowMinutes,
    resetsAt: NOW + resetsInHours * HOUR,
    resetDescription: null
  }
}

function reading(
  session: RateLimitWindow | null,
  weekly: RateLimitWindow | null
): ProviderRateLimits {
  return { provider: 'claude', session, weekly, updatedAt: NOW, error: null, status: 'ok' }
}

function account(id: string): ClaudeManagedAccountSummary {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthRuntime: 'host',
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

/** A host with accounts a, b and c, `a` selected, and the usage state a test feeds it. */
function host(options: { enabled?: boolean; readingAccount?: string } = {}) {
  const accounts: ClaudeRateLimitAccountsState = {
    accounts: ['a', 'b', 'c'].map(account),
    activeAccountId: 'a'
  }
  let listener: (state: RateLimitState) => void = () => {}
  const clock = { now: NOW }
  const select = vi.fn(async (accountId: string) => {
    accounts.activeAccountId = accountId
  })
  const stop = startClaudeUsageLimitAccountSwitch({
    rateLimits: {
      onStateChange: (next) => {
        listener = next
        return () => {}
      },
      usageReadingAccount: () => ({
        home: '/home',
        provenance: `profile:${options.readingAccount ?? accounts.activeAccountId}`
      }),
      fetchInactiveClaudeAccountsOnOpen: async () => {}
    },
    settings: () => ({
      claudeAccountSwitchAtUsageLimit: options.enabled !== false,
      activeClaudeManagedAccountId: accounts.activeAccountId
    }),
    listAccounts: () => accounts,
    select,
    now: () => clock.now
  })
  const publish = async (
    claude: ProviderRateLimits,
    inactive: Record<string, ProviderRateLimits> = {}
  ): Promise<void> => {
    listener(
      createEmptyRateLimitState({
        claude,
        inactiveClaudeAccounts: Object.entries(inactive).map(([accountId, rateLimits]) => ({
          accountId,
          rateLimits,
          updatedAt: NOW,
          isFetching: false
        }))
      })
    )
    // The switch runs behind a few awaits; none of them leaves the microtask queue.
    for (let turn = 0; turn < 10; turn += 1) {
      await Promise.resolve()
    }
  }
  return { publish, select, stop, clock }
}

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  stop = undefined
})

describe('nextClaudeAccountAfterUsageLimit', () => {
  it('orders by soonest weekly reset, leaving unknown and spent accounts for last', () => {
    expect(
      nextClaudeAccountAfterUsageLimit(
        [
          { id: 'unknown', weeklyResetsAt: null, skipUntil: null },
          { id: 'spent', weeklyResetsAt: NOW + HOUR, skipUntil: NOW + HOUR },
          { id: 'later', weeklyResetsAt: NOW + 100 * HOUR, skipUntil: null },
          { id: 'sooner', weeklyResetsAt: NOW + 20 * HOUR, skipUntil: null }
        ],
        NOW
      )
    ).toBe('sooner')
  })

  it('returns no account when every saved account is spent', () => {
    expect(
      nextClaudeAccountAfterUsageLimit(
        [{ id: 'spent', weeklyResetsAt: NOW + HOUR, skipUntil: NOW + HOUR }],
        NOW
      )
    ).toBeNull()
  })
})

describe('startClaudeUsageLimitAccountSwitch', () => {
  it('takes an account again as soon as its own limit has reset', async () => {
    const run = host()
    stop = run.stop
    const spent = { b: reading(window(100, 0.1, 300), null), c: reading(window(100, 2, 300), null) }
    await run.publish(reading(null, window(100, 8)), spent)
    expect(run.select).not.toHaveBeenCalled()
    // b's 5-hour window reset a minute ago (6 minutes in); the 15-minute pause must not outlast it.
    run.clock.now = NOW + 7 * 60_000
    await run.publish({ ...reading(null, window(100, 8)), updatedAt: run.clock.now }, spent)
    expect(run.select.mock.calls).toEqual([['b']])
  })

  it('does not extend a spent account with no known reset each time its reading repeats', async () => {
    const run = host()
    stop = run.stop
    const noReset = {
      usedPercent: 100,
      windowMinutes: 10080,
      resetsAt: null,
      resetDescription: null
    }
    const inactive = { b: reading(null, noReset), c: reading(null, noReset) }
    await run.publish(reading(null, window(50, 8)), inactive)
    run.clock.now = NOW + 10 * 60_000
    await run.publish({ ...reading(null, window(60, 8)), updatedAt: run.clock.now }, inactive)
    // 16 minutes after the first sighting: the 15-minute pass-over has run out.
    run.clock.now = NOW + 16 * 60_000
    await run.publish({ ...reading(null, window(100, 8)), updatedAt: run.clock.now }, inactive)
    expect(run.select).toHaveBeenCalledTimes(1)
  })

  it('selects the account whose weekly limit resets soonest once the selected one is spent', async () => {
    const run = host()
    stop = run.stop
    await run.publish(reading(null, window(100, 8)), {
      b: reading(null, window(40, 120)),
      c: reading(null, window(10, 30))
    })
    expect(run.select.mock.calls).toEqual([['c']])
  })

  it('stays on the selected account below the limit', async () => {
    const run = host()
    stop = run.stop
    await run.publish(reading(window(99, 2, 300), window(99, 8)))
    expect(run.select).not.toHaveBeenCalled()
  })

  it('ignores a spent reading taken under another account', async () => {
    const run = host({ readingAccount: 'b' })
    stop = run.stop
    await run.publish(reading(null, window(100, 8)))
    expect(run.select).not.toHaveBeenCalled()
  })

  it('does nothing while the setting is off', async () => {
    const run = host({ enabled: false })
    stop = run.stop
    await run.publish(reading(null, window(100, 8)))
    expect(run.select).not.toHaveBeenCalled()
  })

  it('never returns to an account it left at its limit', async () => {
    const run = host()
    stop = run.stop
    await run.publish(reading(null, window(100, 8)), { b: reading(null, window(40, 120)) })
    expect(run.select.mock.calls).toEqual([['b']])
    // Now on b, which also runs out: c is next, and a stays skipped until its reset.
    await run.publish(reading(window(100, 3, 300), window(60, 120)))
    expect(run.select.mock.calls).toEqual([['b'], ['c']])
  })
})
