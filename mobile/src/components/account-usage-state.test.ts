import { describe, expect, it } from 'vitest'

import {
  getInactiveProviderUsage,
  decodeAccountsSnapshot,
  getOtherUsageProviders,
  getUsageBarState,
  hasActiveProviderUsage,
  hasRenderableUsage,
  type AccountProviderRateLimits,
  type AccountsSnapshot,
  type InactiveAccountUsage,
  type ProviderRateLimits
} from './account-usage-state'

function makeLimits(overrides: Partial<AccountProviderRateLimits> = {}): AccountProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: 0,
    error: null,
    status: 'idle',
    ...overrides
  }
}

function makeSnapshot(
  overrides: {
    claudeLimits?: AccountProviderRateLimits | null
    codexLimits?: AccountProviderRateLimits | null
    claudeAccounts?: AccountsSnapshot['claude']['accounts']
    codexAccounts?: AccountsSnapshot['codex']['accounts']
    inactiveClaudeAccounts?: InactiveAccountUsage[]
    inactiveCodexAccounts?: InactiveAccountUsage[]
  } = {}
): AccountsSnapshot {
  return {
    claude: {
      accounts: overrides.claudeAccounts ?? [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    codex: {
      accounts: overrides.codexAccounts ?? [],
      activeAccountId: null,
      activeAccountIdsByRuntime: { host: null, wsl: {} }
    },
    rateLimits: {
      claude: overrides.claudeLimits ?? null,
      codex: overrides.codexLimits ?? null,
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: overrides.inactiveClaudeAccounts ?? [],
      inactiveCodexAccounts: overrides.inactiveCodexAccounts ?? []
    }
  }
}

describe('hasActiveProviderUsage', () => {
  it('is false when there are no rate limits at all', () => {
    expect(hasActiveProviderUsage(null)).toBe(false)
  })

  it('is true when a session window has data', () => {
    expect(
      hasActiveProviderUsage(
        makeLimits({
          status: 'ok',
          session: { usedPercent: 12, windowMinutes: 300, resetsAt: null, resetDescription: null }
        })
      )
    ).toBe(true)
  })

  it('is true when a successful fetch returned ok even with empty windows', () => {
    expect(hasActiveProviderUsage(makeLimits({ status: 'ok' }))).toBe(true)
  })

  it('is false for an unavailable/error provider with no window data (no creds)', () => {
    expect(hasActiveProviderUsage(makeLimits({ status: 'unavailable' }))).toBe(false)
    expect(hasActiveProviderUsage(makeLimits({ status: 'error', error: 'nope' }))).toBe(false)
  })
})

describe('hasRenderableUsage', () => {
  it('is true when the provider has at least one managed account', () => {
    const snapshot = makeSnapshot({
      claudeAccounts: [{ id: 'a', email: 'x@y.z' }]
    })
    expect(hasRenderableUsage(snapshot, 'claude')).toBe(true)
  })

  // System-default auth has no managed accounts but real usage; home must not hide it.
  it('is true with zero managed accounts when active rate-limit data exists (system default)', () => {
    const snapshot = makeSnapshot({
      codexLimits: makeLimits({
        provider: 'codex',
        status: 'ok',
        session: { usedPercent: 40, windowMinutes: 300, resetsAt: null, resetDescription: null }
      })
    })
    expect(hasRenderableUsage(snapshot, 'codex')).toBe(true)
  })

  it('is false with zero accounts and no usable rate-limit data', () => {
    const snapshot = makeSnapshot({
      claudeLimits: makeLimits({ status: 'unavailable' })
    })
    expect(hasRenderableUsage(snapshot, 'claude')).toBe(false)
    expect(hasRenderableUsage(makeSnapshot(), 'claude')).toBe(false)
  })
})

describe('getInactiveProviderUsage', () => {
  it('returns inactive usage using the runtime rateLimits payload shape', () => {
    const limits = makeLimits({
      status: 'ok',
      session: { usedPercent: 52, windowMinutes: 300, resetsAt: null, resetDescription: null }
    })
    const snapshot = makeSnapshot({
      inactiveClaudeAccounts: [
        { accountId: 'account-1', rateLimits: limits, updatedAt: 123, isFetching: false }
      ]
    })

    expect(getInactiveProviderUsage(snapshot, 'claude', 'account-1')?.rateLimits).toBe(limits)
  })
})

describe('getUsageBarState', () => {
  it('keeps stale window data visible during a transient error', () => {
    const session = { usedPercent: 72, windowMinutes: 300, resetsAt: null, resetDescription: null }
    const bar = getUsageBarState(
      makeLimits({ status: 'error', error: 'temporarily unavailable', session }),
      session
    )

    expect(bar).toEqual({ usedPercent: 72, unavailable: false, loading: false })
  })

  it('shows loading for a fetching provider without a window', () => {
    expect(getUsageBarState(makeLimits({ status: 'fetching' }), null)).toEqual({
      usedPercent: null,
      unavailable: false,
      loading: true
    })
  })
})

function providerLimits(
  provider: string,
  overrides: Partial<ProviderRateLimits>
): ProviderRateLimits {
  return { ...makeLimits(), ...overrides, provider }
}

describe('getOtherUsageProviders', () => {
  it('lists every set-up provider the host sends, in host order, beside Claude and Codex', () => {
    const week = { usedPercent: 12, windowMinutes: 10_080, resetsAt: null, resetDescription: null }
    const host = makeSnapshot({ claudeLimits: makeLimits({ status: 'ok', weekly: week }) })
    const snapshot = decodeAccountsSnapshot({
      ...host,
      rateLimits: {
        ...host.rateLimits,
        gemini: providerLimits('gemini', {
          status: 'unavailable',
          error: 'OAuth disabled'
        }),
        antigravity: providerLimits('antigravity', {
          status: 'ok',
          buckets: [
            { name: 'Gemini Models', group: 'Gemini Models', ...week },
            { name: 'Claude and GPT models', ...week, windowMinutes: 0 }
          ]
        }),
        kimi: providerLimits('kimi', {
          status: 'idle'
        }),
        grok: providerLimits('grok', {
          status: 'ok',
          weekly: week
        }),
        cursor: providerLimits('cursor', {
          status: 'error',
          error: 'Cursor is down'
        }),
        'future-agent': providerLimits('future-agent', {
          status: 'ok',
          monthly: week
        }),
        broken: { provider: 'broken', status: 'ok', weekly: { usedPercent: 'lots' } },
        grokAuthConfigured: true
      }
    })

    expect(getOtherUsageProviders(snapshot).map((limits) => limits.provider)).toEqual([
      'antigravity',
      'grok',
      'cursor',
      'future-agent'
    ])
  })
})
