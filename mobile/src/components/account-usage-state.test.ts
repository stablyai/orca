import { describe, expect, it } from 'vitest'

import {
  getActiveAdditionalProviders,
  getAdditionalProviderUsageRows,
  getInactiveProviderUsage,
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  hasAnyRenderableUsage,
  hasRenderableUsage,
  type AccountsSnapshot,
  type InactiveAccountUsage,
  type ProviderRateLimits
} from './account-usage-state'

function makeLimits(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
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
    claudeLimits?: ProviderRateLimits | null
    codexLimits?: ProviderRateLimits | null
    claudeAccounts?: AccountsSnapshot['claude']['accounts']
    codexAccounts?: AccountsSnapshot['codex']['accounts']
    inactiveClaudeAccounts?: InactiveAccountUsage[]
    inactiveCodexAccounts?: InactiveAccountUsage[]
    extraRateLimits?: Partial<AccountsSnapshot['rateLimits']>
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
      inactiveCodexAccounts: overrides.inactiveCodexAccounts ?? [],
      ...overrides.extraRateLimits
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

  // The bug: system-default auth has zero managed accounts but real usage data,
  // and the home screen used to hide it entirely.
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

describe('getWindowResetLabel', () => {
  const now = 1_700_000_000_000
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour

  function makeWindow(resetsAt: number | null): ProviderRateLimits['session'] {
    return { usedPercent: 13, windowMinutes: 300, resetsAt, resetDescription: null }
  }

  it('is null when there are no limits or the window has no reset timestamp', () => {
    expect(getWindowResetLabel(null, 'session', now)).toBe(null)
    expect(getWindowResetLabel(makeLimits({ status: 'ok' }), 'session', now)).toBe(null)
    expect(
      getWindowResetLabel(makeLimits({ status: 'ok', session: makeWindow(null) }), 'session', now)
    ).toBe(null)
  })

  it('formats minutes, hours+minutes, and days+hours like the desktop tooltip', () => {
    expect(
      getWindowResetLabel(makeLimits({ session: makeWindow(now + 47 * min) }), 'session', now)
    ).toBe('Resets in 47m')
    expect(
      getWindowResetLabel(
        makeLimits({ session: makeWindow(now + 3 * hour + 54 * min) }),
        'session',
        now
      )
    ).toBe('Resets in 3h 54m')
    expect(
      getWindowResetLabel(
        makeLimits({ weekly: makeWindow(now + 6 * day + 7 * hour) }),
        'weekly',
        now
      )
    ).toBe('Resets in 6d 7h')
  })

  it('formats exact hours and exact days without a zero remainder', () => {
    expect(
      getWindowResetLabel(makeLimits({ session: makeWindow(now + 2 * hour) }), 'session', now)
    ).toBe('Resets in 2h')
    expect(
      getWindowResetLabel(makeLimits({ weekly: makeWindow(now + 7 * day) }), 'weekly', now)
    ).toBe('Resets in 7d')
  })

  it('reports "Resets now" for a reset timestamp in the past', () => {
    expect(
      getWindowResetLabel(makeLimits({ session: makeWindow(now - min) }), 'session', now)
    ).toBe('Resets now')
  })

  it('reads the requested window only', () => {
    const limits = makeLimits({ session: makeWindow(now + hour) })
    expect(getWindowResetLabel(limits, 'weekly', now)).toBe(null)
  })
})

describe('getUsageBarState', () => {
  it('keeps stale window data visible during a transient error', () => {
    const bar = getUsageBarState(
      makeLimits({
        status: 'error',
        error: 'temporarily unavailable',
        session: { usedPercent: 72, windowMinutes: 300, resetsAt: null, resetDescription: null }
      }),
      'session'
    )

    expect(bar).toEqual({ usedPercent: 72, unavailable: false, loading: false })
  })

  it('shows loading for a fetching provider without a window', () => {
    expect(getUsageBarState(makeLimits({ status: 'fetching' }), 'weekly')).toEqual({
      usedPercent: null,
      unavailable: false,
      loading: true
    })
  })
})

function windowOf(
  usedPercent: number,
  windowMinutes: number,
  resetsAt: number | null = null
): NonNullable<ProviderRateLimits['session']> {
  return { usedPercent, windowMinutes, resetsAt, resetDescription: null }
}

describe('getActiveAdditionalProviders', () => {
  it('returns active providers in roster order and drops unavailable or idle empties', () => {
    const grok = makeLimits({
      provider: 'grok',
      status: 'ok',
      weekly: windowOf(12, 10080)
    })
    const antigravity = makeLimits({
      provider: 'antigravity',
      status: 'error',
      error: 'agy unavailable'
    })
    const snapshot = makeSnapshot({
      extraRateLimits: {
        zcode: makeLimits({ provider: 'zcode', status: 'unavailable' }),
        gemini: makeLimits({ provider: 'gemini', status: 'idle' }),
        grok,
        antigravity,
        cursor: null
      }
    })

    expect(getActiveAdditionalProviders(snapshot).map((entry) => entry.key)).toEqual([
      'antigravity',
      'grok'
    ])
    expect(getActiveAdditionalProviders(snapshot)[0]?.limits).toBe(antigravity)
  })
})

describe('getAdditionalProviderUsageRows', () => {
  const now = 1_700_000_000_000
  const hour = 60 * 60_000

  it('groups Antigravity pools and sorts each pool by window length', () => {
    const rows = getAdditionalProviderUsageRows(
      makeLimits({
        provider: 'antigravity',
        status: 'ok',
        buckets: [
          {
            name: 'Gemini Models',
            group: 'Gemini Models',
            ...windowOf(4, 10080, now + 6 * hour)
          },
          {
            name: 'Gemini Models',
            group: 'Gemini Models',
            ...windowOf(10, 300, now + 2 * hour)
          },
          {
            name: 'Claude and GPT models',
            group: 'Claude and GPT models',
            windowName: 'Weekly Limit Remaining',
            ...windowOf(20, 10080)
          }
        ]
      }),
      now
    )

    expect(rows).toEqual([
      {
        title: 'Gemini Models',
        bars: [
          {
            label: '5h',
            usedPercent: 10,
            unavailable: false,
            loading: false,
            resetText: 'Resets in 2h'
          },
          {
            label: '7d',
            usedPercent: 4,
            unavailable: false,
            loading: false,
            resetText: 'Resets in 6h'
          }
        ]
      },
      {
        title: 'Claude and GPT models',
        bars: [
          {
            label: '7d',
            usedPercent: 20,
            unavailable: false,
            loading: false,
            resetText: null
          }
        ]
      }
    ])
  })

  it('puts a Cursor plan meter ahead of named buckets', () => {
    const rows = getAdditionalProviderUsageRows(
      makeLimits({
        provider: 'cursor',
        status: 'ok',
        planType: 'pro',
        monthly: windowOf(12, 43200),
        buckets: [
          { name: 'Cursor Models', ...windowOf(40, 43200) },
          { name: 'Other Models', ...windowOf(7, 1440) }
        ]
      }),
      now
    )

    expect(rows.map((row) => [row.title, row.bars.map((bar) => bar.label)])).toEqual([
      ['Plan', ['30d']],
      ['Cursor Models', ['30d']],
      ['Other Models', ['24h']]
    ])
    expect(rows[0]?.bars[0]?.usedPercent).toBe(12)
    expect(rows[1]?.bars[0]?.usedPercent).toBe(40)
  })

  it('labels a monthly window without a plan as Monthly', () => {
    const rows = getAdditionalProviderUsageRows(
      makeLimits({
        provider: 'cursor',
        status: 'ok',
        monthly: windowOf(3, 43200),
        buckets: [{ name: 'Cursor Models', ...windowOf(1, 43200) }]
      }),
      now
    )

    expect(rows[0]?.title).toBe('Monthly')
  })

  it('uses Grok email provenance as the row title', () => {
    const rows = getAdditionalProviderUsageRows(
      makeLimits({
        provider: 'grok',
        status: 'ok',
        weekly: windowOf(15, 10080, now + 3 * hour),
        usageMetadata: { authProvenance: 'dev@example.com (SuperGrok)' }
      }),
      now
    )

    expect(rows).toEqual([
      {
        title: 'dev@example.com (SuperGrok)',
        bars: [
          {
            label: '7d',
            usedPercent: 15,
            unavailable: false,
            loading: false,
            resetText: 'Resets in 3h'
          }
        ]
      }
    ])
  })

  it('labels Z.ai monthly quota as MCP and falls back when provenance has no email', () => {
    const rows = getAdditionalProviderUsageRows(
      makeLimits({
        provider: 'zcode',
        status: 'ok',
        session: windowOf(12, 300),
        weekly: windowOf(44, 10080),
        monthly: windowOf(3, 43200),
        usageMetadata: { authProvenance: 'a'.repeat(64) }
      }),
      now
    )

    expect(rows).toEqual([
      {
        title: 'System default',
        bars: [
          { label: '5h', usedPercent: 12, unavailable: false, loading: false, resetText: null },
          { label: '7d', usedPercent: 44, unavailable: false, loading: false, resetText: null },
          { label: 'MCP', usedPercent: 3, unavailable: false, loading: false, resetText: null }
        ]
      }
    ])
  })
})

describe('hasAnyRenderableUsage', () => {
  it('is false when every provider is empty', () => {
    expect(hasAnyRenderableUsage(makeSnapshot())).toBe(false)
  })

  it('is true for a managed Claude account or an active additional provider', () => {
    expect(
      hasAnyRenderableUsage(makeSnapshot({ claudeAccounts: [{ id: 'a', email: 'x@y.z' }] }))
    ).toBe(true)
    expect(
      hasAnyRenderableUsage(
        makeSnapshot({
          extraRateLimits: {
            gemini: makeLimits({
              provider: 'gemini',
              status: 'ok',
              buckets: [{ name: 'Flash', ...windowOf(8, 60) }]
            })
          }
        })
      )
    ).toBe(true)
  })
})
