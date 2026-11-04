import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'
import type { ProviderRateLimits, RateLimitState } from '../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../shared/rate-limit-state-factory'
import {
  startClaudeAccountAutoSwitch,
  type ClaudeAutoSwitchSettings
} from './claude-account-auto-switch'

const NOW = Date.UTC(2026, 10, 4, 12)
const HOUR = 60 * 60 * 1000

function usage(sessionUsed: number, weeklyUsed: number, sessionResetsAt = NOW + HOUR) {
  return {
    provider: 'claude',
    session: {
      usedPercent: sessionUsed,
      windowMinutes: 300,
      resetsAt: sessionResetsAt,
      resetDescription: null
    },
    weekly: {
      usedPercent: weeklyUsed,
      windowMinutes: 10080,
      resetsAt: NOW + 48 * HOUR,
      resetDescription: null
    },
    updatedAt: NOW,
    error: null,
    status: 'ok'
  } satisfies ProviderRateLimits
}

function account(id: string) {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthRuntime: 'host' as const,
    wslDistro: null,
    authMethod: 'unknown' as const,
    organizationUuid: null,
    organizationName: null,
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

const accounts: ClaudeRateLimitAccountsState = {
  accounts: [account('a'), account('b'), account('c')],
  activeAccountId: 'a'
}

function setup(
  inactive: Record<string, ProviderRateLimits>,
  settings: Partial<ClaudeAutoSwitchSettings> = {}
) {
  let state = createEmptyRateLimitState({
    claude: usage(95, 50),
    inactiveClaudeAccounts: Object.entries(inactive).map(([accountId, rateLimits]) => ({
      accountId,
      rateLimits,
      updatedAt: NOW,
      isFetching: false
    }))
  })
  let listener: (next: RateLimitState) => void = () => {}
  const select = vi.fn(async () => {})
  const notifyNoCandidate = vi.fn()
  startClaudeAccountAutoSwitch({
    getSettings: () => ({
      claudeAccountAutoSwitch: true,
      activeClaudeManagedAccountId: 'a',
      activeClaudeManagedAccountIdsByRuntime: { host: 'a', wsl: {} },
      ...settings
    }),
    rateLimits: {
      getState: () => state,
      onStateChange: (next) => {
        listener = next
        return () => {}
      },
      fetchInactiveClaudeAccountsOnOpen: async () => {}
    },
    claudeAccounts: { listAccounts: () => accounts, hasPendingLogin: () => false },
    select,
    notifyNoCandidate
  })
  const push = async (claude: ProviderRateLimits): Promise<void> => {
    state = { ...state, claude }
    listener(state)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return { push, select, notifyNoCandidate }
}

describe('startClaudeAccountAutoSwitch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('selects the qualifying account with the most usage left once the 5-hour minimum is crossed', async () => {
    // b has 40 % session but only 2 % weekly left (below 3 %); c has 30 % / 60 %.
    const { push, select } = setup({ b: usage(60, 98), c: usage(70, 40) })
    await push(usage(91, 50))
    expect(select).not.toHaveBeenCalled()
    await push(usage(93, 50))
    expect(select).toHaveBeenCalledExactlyOnceWith('c')
  })

  it('stays off unless the setting is on', async () => {
    const { push, select } = setup({ c: usage(10, 10) }, { claudeAccountAutoSwitch: undefined })
    await push(usage(99, 99))
    expect(select).not.toHaveBeenCalled()
  })

  it('ignores readings past their reset and failed readings', async () => {
    const { push, select, notifyNoCandidate } = setup({
      b: usage(10, 10, NOW - 1),
      c: { ...usage(10, 10), status: 'error' }
    })
    await push(usage(99, 50, NOW - 1))
    expect(notifyNoCandidate).not.toHaveBeenCalled()
    await push(usage(99, 50))
    expect(select).not.toHaveBeenCalled()
    expect(notifyNoCandidate).toHaveBeenCalledExactlyOnceWith(accounts, 'a')
  })

  it('makes at most one attempt per cooldown', async () => {
    const { push, select } = setup({ c: usage(10, 10) })
    await push(usage(99, 50))
    await push(usage(99, 50))
    expect(select).toHaveBeenCalledTimes(1)
    vi.setSystemTime(NOW + 11 * 60 * 1000)
    await push({ ...usage(99, 50), updatedAt: NOW + 11 * 60 * 1000 })
    expect(select).toHaveBeenCalledTimes(2)
  })
})
