import { describe, expect, it } from 'vitest'

import { decodeAccountsSnapshot } from './accounts-snapshot'
import { getUsageBarState, getWindowResetLabel } from './account-usage-state'
import { getExtraProviderUsage } from './extra-provider-usage'

function makeWindow(usedPercent: number, windowMinutes: number, resetsAt: number | null = null) {
  return { usedPercent, windowMinutes, resetsAt, resetDescription: null }
}

function makeLimits(provider: string, overrides: Record<string, unknown> = {}) {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok',
    ...overrides
  }
}

// Why: goes through decodeAccountsSnapshot so the tests cover what the phone
// actually keeps from a host payload, not a hand-built typed object.
function decodeWithRateLimits(extra: Record<string, unknown>) {
  return decodeAccountsSnapshot({
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: makeLimits('claude', { session: makeWindow(10, 300) }),
      codex: null,
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: [],
      ...extra
    }
  })
}

describe('getExtraProviderUsage', () => {
  it('returns Grok weekly and monthly windows in display order', () => {
    const snapshot = decodeWithRateLimits({
      grok: makeLimits('grok', {
        monthly: makeWindow(40, 43_200),
        weekly: makeWindow(25, 10_080)
      })
    })

    expect(getExtraProviderUsage(snapshot)).toEqual([
      expect.objectContaining({ key: 'grok', title: 'Grok', windows: ['weekly', 'monthly'] })
    ])
  })

  it('lists providers in a stable order regardless of payload order', () => {
    const snapshot = decodeWithRateLimits({
      minimax: makeLimits('minimax', { session: makeWindow(5, 300) }),
      antigravity: makeLimits('antigravity', { weekly: makeWindow(12, 10_080) }),
      grok: makeLimits('grok', { weekly: makeWindow(1, 10_080) })
    })

    expect(getExtraProviderUsage(snapshot).map((usage) => usage.key)).toEqual([
      'grok',
      'antigravity',
      'minimax'
    ])
  })

  it('shows nothing extra for hosts that only publish Claude and Codex', () => {
    expect(getExtraProviderUsage(decodeWithRateLimits({}))).toEqual([])
  })

  it('hides a provider the host has no credentials for', () => {
    const snapshot = decodeWithRateLimits({
      antigravity: makeLimits('antigravity', {
        status: 'unavailable',
        error: 'Antigravity usage is not available.'
      }),
      gemini: null
    })

    expect(getExtraProviderUsage(snapshot)).toEqual([])
  })

  it('keeps the last windows and the error after a failed refresh', () => {
    const snapshot = decodeWithRateLimits({
      grok: makeLimits('grok', {
        status: 'error',
        error: 'Network error',
        weekly: makeWindow(30, 10_080)
      })
    })

    expect(getExtraProviderUsage(snapshot)).toEqual([
      expect.objectContaining({ key: 'grok', windows: ['weekly'] })
    ])
    expect(getExtraProviderUsage(snapshot)[0]?.limits.error).toBe('Network error')
  })

  it('drops a malformed entry without rejecting the Claude and Codex snapshot', () => {
    const snapshot = decodeWithRateLimits({
      grok: { provider: 'grok', session: 'not-a-window' },
      kimi: makeLimits('kimi', { weekly: makeWindow(50, 10_080) })
    })

    expect(snapshot.rateLimits.claude?.session?.usedPercent).toBe(10)
    expect(getExtraProviderUsage(snapshot).map((usage) => usage.key)).toEqual(['kimi'])
  })

  it('ignores an entry stamped with another provider identity', () => {
    const snapshot = decodeWithRateLimits({
      grok: makeLimits('claude', { weekly: makeWindow(70, 10_080) })
    })

    expect(getExtraProviderUsage(snapshot)).toEqual([])
  })

  it('maps the OpenCode Go field to its hyphenated provider id', () => {
    const snapshot = decodeWithRateLimits({
      opencodeGo: makeLimits('opencode-go', { monthly: makeWindow(8, 43_200) })
    })

    expect(getExtraProviderUsage(snapshot)).toEqual([
      expect.objectContaining({ key: 'opencodeGo', title: 'OpenCode Go', windows: ['monthly'] })
    ])
  })
})

describe('monthly window selectors', () => {
  it('reads the monthly bar and its reset countdown', () => {
    const [usage] = getExtraProviderUsage(
      decodeWithRateLimits({
        grok: makeLimits('grok', { monthly: makeWindow(64.6, 43_200, 3_600_000) })
      })
    )

    expect(usage).toBeDefined()
    const limits = usage?.limits ?? null
    expect(getUsageBarState(limits, 'monthly')).toEqual({
      usedPercent: 64.6,
      unavailable: false,
      loading: false
    })
    expect(getWindowResetLabel(limits, 'monthly', 0)).toMatch(/^Resets in/)
  })
})
