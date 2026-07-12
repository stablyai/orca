import { describe, expect, it } from 'vitest'

import {
  getActiveProviderRateLimits,
  getInactiveProviderUsage,
  getProviderUsageWindows,
  getUsageBarState,
  hasActiveProviderUsage,
  hasRenderableUsage,
  USAGE_PROVIDER_IDS,
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
    geminiLimits?: ProviderRateLimits | null
    grokLimits?: ProviderRateLimits | null
    claudeAccounts?: AccountsSnapshot['claude']['accounts']
    codexAccounts?: AccountsSnapshot['codex']['accounts']
    inactiveClaudeAccounts?: InactiveAccountUsage[]
    inactiveCodexAccounts?: InactiveAccountUsage[]
  } = {}
): AccountsSnapshot {
  return {
    claude: { accounts: overrides.claudeAccounts ?? [], activeAccountId: null },
    codex: { accounts: overrides.codexAccounts ?? [], activeAccountId: null },
    rateLimits: {
      claude: overrides.claudeLimits ?? null,
      codex: overrides.codexLimits ?? null,
      gemini: overrides.geminiLimits ?? null,
      grok: overrides.grokLimits ?? null,
      inactiveClaudeAccounts: overrides.inactiveClaudeAccounts ?? [],
      inactiveCodexAccounts: overrides.inactiveCodexAccounts ?? []
    }
  }
}

function window(usedPercent: number, windowMinutes = 300) {
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

describe('getActiveProviderRateLimits', () => {
  it('reads a display-only provider (grok) via its descriptor field', () => {
    const grok = makeLimits({ provider: 'grok', status: 'ok', session: window(15) })
    expect(getActiveProviderRateLimits(makeSnapshot({ grokLimits: grok }), 'grok')).toBe(grok)
  })

  it('maps opencode-go wire id to the opencodeGo snapshot field', () => {
    const snapshot = makeSnapshot()
    const openCode = makeLimits({
      provider: 'opencode-go',
      status: 'ok',
      monthly: window(30, 43200)
    })
    ;(snapshot.rateLimits as { opencodeGo?: ProviderRateLimits }).opencodeGo = openCode
    expect(getActiveProviderRateLimits(snapshot, 'opencode-go')).toBe(openCode)
  })

  // Old home-snapshot-cache v1 entries predate these fields; a missing field
  // must normalize to null instead of undefined so cold-start hydration can't
  // throw when a selector dereferences it.
  it('returns null for a provider field absent from an old cached snapshot', () => {
    const legacy = {
      claude: { accounts: [], activeAccountId: null },
      codex: { accounts: [], activeAccountId: null },
      rateLimits: {
        claude: null,
        codex: null,
        inactiveClaudeAccounts: [],
        inactiveCodexAccounts: []
      }
    } as AccountsSnapshot
    expect(getActiveProviderRateLimits(legacy, 'gemini')).toBeNull()
    expect(getActiveProviderRateLimits(legacy, 'minimax')).toBeNull()
  })
})

describe('getProviderUsageWindows', () => {
  it('returns no rows for missing limits', () => {
    expect(getProviderUsageWindows(null)).toEqual([])
  })

  it('expands Gemini named buckets with index-stable keys', () => {
    const gemini = makeLimits({
      provider: 'gemini',
      status: 'ok',
      buckets: [
        { name: 'Pro', ...window(20) },
        { name: 'Flash', ...window(5) }
      ]
    })
    expect(getProviderUsageWindows(gemini)).toEqual([
      { key: 'bucket:0:Pro', label: 'Pro', usedPercent: 20 },
      { key: 'bucket:1:Flash', label: 'Flash', usedPercent: 5 }
    ])
  })

  // The host sets session = deriveSessionSummary(buckets) (the most-constrained
  // bucket), so buckets are authoritative and the synthesized session row must
  // not double-show it.
  it('omits the derived session row when Gemini reports buckets', () => {
    const gemini = makeLimits({
      provider: 'gemini',
      status: 'ok',
      session: window(20), // mirrors the worst bucket
      buckets: [
        { name: 'Pro', ...window(20) },
        { name: 'Flash', ...window(5) }
      ]
    })
    expect(getProviderUsageWindows(gemini)).toEqual([
      { key: 'bucket:0:Pro', label: 'Pro', usedPercent: 20 },
      { key: 'bucket:1:Flash', label: 'Flash', usedPercent: 5 }
    ])
  })

  it('includes OpenCode Go monthly window', () => {
    const openCode = makeLimits({
      provider: 'opencode-go',
      status: 'ok',
      monthly: window(42, 43200)
    })
    expect(getProviderUsageWindows(openCode)).toEqual([
      { key: 'monthly', label: '30d', usedPercent: 42 }
    ])
  })

  it('returns session and weekly rows for the classic two-window shape', () => {
    const claude = makeLimits({ status: 'ok', session: window(10), weekly: window(60, 10080) })
    expect(getProviderUsageWindows(claude)).toEqual([
      { key: 'session', label: '5h', usedPercent: 10 },
      { key: 'weekly', label: '7d', usedPercent: 60 }
    ])
  })
})

describe('hasRenderableUsage for display-only providers', () => {
  it('is true for grok when the system-default target has active usage', () => {
    const snapshot = makeSnapshot({
      grokLimits: makeLimits({ provider: 'grok', status: 'ok', weekly: window(33, 10080) })
    })
    expect(hasRenderableUsage(snapshot, 'grok')).toBe(true)
  })

  it('is false for a display-only provider with no data (no managed-account fallback)', () => {
    expect(hasRenderableUsage(makeSnapshot(), 'grok')).toBe(false)
  })
})

describe('USAGE_PROVIDER_IDS', () => {
  it('covers all seven providers the desktop tracks', () => {
    expect(USAGE_PROVIDER_IDS).toEqual([
      'claude',
      'codex',
      'gemini',
      'opencode-go',
      'kimi',
      'minimax',
      'grok'
    ])
  })
})
