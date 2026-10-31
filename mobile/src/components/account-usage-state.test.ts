import { describe, expect, it } from 'vitest'

import {
  collectProviderUsageMeters,
  getGrokUsageWindowKey,
  getInactiveProviderUsage,
  getUsageBarState,
  getWindowResetLabel,
  hasActiveProviderUsage,
  hasRenderableGrokUsage,
  hasRenderableProviderUsage,
  hasRenderableUsage,
  readUsageAuthProvenance,
  type AccountsSnapshot,
  type InactiveAccountUsage,
  type MobileUsageProviderId,
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
    grokLimits?: ProviderRateLimits | null
    grokAuthConfigured?: boolean
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
      ...(overrides.grokLimits !== undefined ? { grok: overrides.grokLimits } : {}),
      ...(overrides.grokAuthConfigured !== undefined
        ? { grokAuthConfigured: overrides.grokAuthConfigured }
        : {}),
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: overrides.inactiveClaudeAccounts ?? [],
      inactiveCodexAccounts: overrides.inactiveCodexAccounts ?? [],
      ...overrides.extraRateLimits
    }
  }
}

function limitWindow(usedPercent: number, windowMinutes: number) {
  return { usedPercent, windowMinutes, resetsAt: null, resetDescription: null }
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

  it('reads a monthly window for providers that have no session or weekly limit', () => {
    expect(
      getUsageBarState(
        makeLimits({
          provider: 'grok',
          status: 'ok',
          monthly: { usedPercent: 25, windowMinutes: 43200, resetsAt: null, resetDescription: null }
        }),
        'monthly'
      )
    ).toEqual({ usedPercent: 25, unavailable: false, loading: false })
  })
})

describe('Grok usage visibility', () => {
  it('stays hidden when the host omits Grok', () => {
    expect(hasRenderableGrokUsage(makeSnapshot())).toBe(false)
  })

  it('stays hidden for an unavailable snapshot with no windows', () => {
    expect(
      hasRenderableGrokUsage(
        makeSnapshot({
          grokLimits: makeLimits({ provider: 'grok', status: 'unavailable' })
        })
      )
    ).toBe(false)
  })

  it('shows a configured CLI session before the first usage payload arrives', () => {
    expect(hasRenderableGrokUsage(makeSnapshot({ grokAuthConfigured: true }))).toBe(true)
  })

  it('shows weekly credits, and monthly usage only when weekly is absent', () => {
    const weekly = makeLimits({
      provider: 'grok',
      status: 'ok',
      weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null, resetDescription: null },
      monthly: { usedPercent: 10, windowMinutes: 43200, resetsAt: null, resetDescription: null }
    })
    const monthly = makeLimits({
      provider: 'grok',
      status: 'ok',
      monthly: { usedPercent: 10, windowMinutes: 43200, resetsAt: null, resetDescription: null }
    })

    expect(hasRenderableGrokUsage(makeSnapshot({ grokLimits: monthly }))).toBe(true)
    expect(getGrokUsageWindowKey(weekly)).toBe('weekly')
    expect(getGrokUsageWindowKey(monthly)).toBe('monthly')
    expect(getGrokUsageWindowKey(null)).toBe('weekly')
  })

  it('keeps a failed refresh visible and reads its auth provenance', () => {
    const limits = makeLimits({
      provider: 'grok',
      status: 'error',
      error: 'session expired',
      usageMetadata: { authProvenance: 'Grok CLI session' }
    })

    expect(hasRenderableGrokUsage(makeSnapshot({ grokLimits: limits }))).toBe(true)
    expect(readUsageAuthProvenance(limits)).toBe('Grok CLI session')
    expect(readUsageAuthProvenance(makeLimits({ provider: 'grok' }))).toBe(null)
  })
})

describe('desktop provider usage on mobile', () => {
  it('shows a provider when its desktop credential flag is set and hides it when the host omits it', () => {
    expect(hasRenderableProviderUsage(makeSnapshot(), 'gemini')).toBe(false)
    expect(hasRenderableProviderUsage(makeSnapshot(), 'minimax')).toBe(false)
    expect(
      hasRenderableProviderUsage(
        makeSnapshot({ extraRateLimits: { minimaxCookieConfigured: true } }),
        'minimax'
      )
    ).toBe(true)
    expect(
      hasRenderableProviderUsage(
        makeSnapshot({ extraRateLimits: { minimaxApiKeyConfigured: true } }),
        'minimax'
      )
    ).toBe(true)
    expect(
      hasRenderableProviderUsage(
        makeSnapshot({ extraRateLimits: { opencodeGoApiKeyConfigured: true } }),
        'opencodeGo'
      )
    ).toBe(true)
    expect(
      hasRenderableProviderUsage(
        makeSnapshot({ extraRateLimits: { cursorAuthConfigured: true } }),
        'cursor'
      )
    ).toBe(true)
    expect(
      hasRenderableProviderUsage(
        makeSnapshot({ extraRateLimits: { zcodePlanApiKeyConfigured: true } }),
        'zcode'
      )
    ).toBe(true)
  })

  it('keeps Gemini and Cursor named pools and drops experimental Gemini buckets', () => {
    const gemini = makeLimits({
      provider: 'gemini',
      status: 'ok',
      buckets: [
        { ...limitWindow(15, 10080), name: 'Flash' },
        { ...limitWindow(90, 10080), name: 'Experimental' },
        { ...limitWindow(40, 10080), name: '1.5 Pro' }
      ]
    })
    const cursor = makeLimits({
      provider: 'cursor',
      status: 'ok',
      monthly: limitWindow(55, 43200),
      buckets: [
        { ...limitWindow(20, 43200), name: 'Cursor Models' },
        { ...limitWindow(5, 43200), name: 'On-demand' }
      ]
    })

    expect(collectProviderUsageMeters('gemini', gemini).map((meter) => meter.title)).toEqual([
      'Flash',
      '1.5 Pro'
    ])
    expect(collectProviderUsageMeters('cursor', cursor).map((meter) => meter.title)).toEqual([
      'Cursor Models',
      'On-demand',
      'Plan'
    ])
    expect(collectProviderUsageMeters('cursor', cursor).map((meter) => meter.usedPercent)).toEqual([
      20, 5, 55
    ])
  })

  it('shows every Zcode window together and a monthly-only OpenCode Go window', () => {
    const zcode = makeLimits({
      provider: 'zcode',
      status: 'ok',
      session: limitWindow(10, 300),
      weekly: limitWindow(20, 10080),
      monthly: limitWindow(30, 43200)
    })
    const opencodeGo = makeLimits({
      provider: 'opencode-go',
      status: 'ok',
      monthly: limitWindow(33, 43200)
    })

    expect(collectProviderUsageMeters('zcode', zcode)).toEqual([
      expect.objectContaining({ key: 'session', chip: '5h', usedPercent: 10 }),
      expect.objectContaining({ key: 'weekly', chip: 'wk', usedPercent: 20 }),
      expect.objectContaining({ key: 'monthly', title: 'MCP monthly', chip: '', usedPercent: 30 })
    ])
    expect(collectProviderUsageMeters('opencodeGo', opencodeGo)).toEqual([
      expect.objectContaining({ key: 'monthly', chip: 'mo', title: null, usedPercent: 33 })
    ])
  })

  it('keeps arbitrary Antigravity pools and hides a provider that only has unnamed leftover buckets', () => {
    const antigravity = makeLimits({
      provider: 'antigravity',
      status: 'ok',
      buckets: [{ ...limitWindow(12, 10080), name: 'Gemini 3 Pro' }]
    })
    const hidden = makeLimits({
      provider: 'gemini',
      status: 'ok',
      buckets: [{ ...limitWindow(90, 10080), name: 'Experimental' }]
    })

    expect(collectProviderUsageMeters('antigravity', antigravity)).toEqual([
      expect.objectContaining({ title: 'Gemini 3 Pro', usedPercent: 12 })
    ])
    expect(
      hasRenderableProviderUsage(
        makeSnapshot({ extraRateLimits: { gemini: hidden } }),
        'gemini' satisfies MobileUsageProviderId
      )
    ).toBe(false)
  })
})
