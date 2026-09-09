import { describe, expect, it } from 'vitest'
import type {
  ProviderRateLimits,
  RateLimitState,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import { projectResourceEvidence } from './resource-evidence-projection'

const QUERIED_AT_MS = Date.parse('2026-09-09T12:00:00.000Z')

function window(overrides: Partial<RateLimitWindow>): RateLimitWindow {
  return {
    usedPercent: 0,
    windowMinutes: 300,
    resetsAt: null,
    resetDescription: null,
    ...overrides
  }
}

function provider(overrides: Partial<ProviderRateLimits>): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: Date.parse('2026-09-09T11:52:00.000Z'),
    error: null,
    status: 'ok',
    ...overrides
  }
}

function state(overrides: Partial<RateLimitState>): RateLimitState {
  return {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    minimaxCookieConfigured: false,
    minimaxApiKeyConfigured: false,
    grokAuthConfigured: false,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: [],
    ...overrides
  }
}

describe('projectResourceEvidence', () => {
  it('projects Codex BURST + BUDGET windows with derived roles and ratios', () => {
    const evidence = projectResourceEvidence(
      state({
        codex: provider({
          provider: 'codex',
          session: window({ usedPercent: 19, windowMinutes: 300, resetsAt: Date.parse('2026-09-09T14:38:00.000Z') }),
          weekly: window({ usedPercent: 52, windowMinutes: 10080, resetsAt: Date.parse('2026-09-15T10:39:00.000Z') }),
          planType: 'plus',
          rateLimitResetCredits: { availableCount: 0 }
        })
      }),
      { queriedAtMs: QUERIED_AT_MS }
    )

    expect(evidence.queriedAt).toBe('2026-09-09T12:00:00.000Z')
    const codex = evidence.providers.codex
    expect(codex).toBeDefined()
    expect(codex?.available).toBe(true)
    expect(codex?.sourceUpdatedAt).toBe('2026-09-09T11:52:00.000Z')
    expect(codex?.dataAgeMs).toBe(QUERIED_AT_MS - Date.parse('2026-09-09T11:52:00.000Z'))
    expect(codex?.windows).toEqual([
      {
        role: 'BURST',
        windowMinutes: 300,
        remainingRatio: 0.81,
        remainingRatioGranularity: 0.01,
        resetAt: '2026-09-09T14:38:00.000Z',
        resetAtSource: 'unknown'
      },
      {
        role: 'BUDGET',
        windowMinutes: 10080,
        remainingRatio: 0.48,
        remainingRatioGranularity: 0.01,
        resetAt: '2026-09-15T10:39:00.000Z',
        resetAtSource: 'unknown'
      }
    ])
    expect(codex?.extras).toEqual({ planType: 'plus', resetCreditsAvailable: 0 })
  })

  it('projects a Claude provider the same way', () => {
    const evidence = projectResourceEvidence(
      state({
        claude: provider({
          provider: 'claude',
          session: window({ usedPercent: 42, windowMinutes: 300 }),
          weekly: window({ usedPercent: 5, windowMinutes: 10080 })
        })
      }),
      { queriedAtMs: QUERIED_AT_MS }
    )
    expect(evidence.providers.claude?.windows.map((w) => w.role)).toEqual(['BURST', 'BUDGET'])
    expect(evidence.providers.claude?.windows[1]?.remainingRatio).toBe(0.95)
  })

  it('keeps Gemini per-model buckets as distinct pool windows', () => {
    const evidence = projectResourceEvidence(
      state({
        gemini: provider({
          provider: 'gemini',
          buckets: [
            { name: 'Flash', usedPercent: 7, windowMinutes: 60, resetsAt: null, resetDescription: null },
            { name: 'Pro', usedPercent: 60, windowMinutes: 60, resetsAt: null, resetDescription: null }
          ]
        })
      }),
      { queriedAtMs: QUERIED_AT_MS }
    )
    expect(evidence.providers.gemini?.windows).toEqual([
      { role: 'BURST', windowMinutes: 60, remainingRatio: 0.93, remainingRatioGranularity: 0.01, resetAt: null, resetAtSource: 'unknown', pool: 'Flash' },
      { role: 'BURST', windowMinutes: 60, remainingRatio: 0.4, remainingRatioGranularity: 0.01, resetAt: null, resetAtSource: 'unknown', pool: 'Pro' }
    ])
  })

  it('exposes whatever Antigravity state is present without inventing reset provenance', () => {
    const evidence = projectResourceEvidence(
      state({
        antigravity: provider({
          provider: 'antigravity',
          weekly: window({ usedPercent: 1, windowMinutes: 10080, resetsAt: Date.parse('2026-09-16T00:00:00.000Z') })
        })
      }),
      { queriedAtMs: QUERIED_AT_MS }
    )
    expect(evidence.providers.antigravity?.windows[0]?.resetAtSource).toBe('unknown')
  })

  it('marks an unavailable/error provider unavailable with no windows', () => {
    const evidence = projectResourceEvidence(
      state({ codex: provider({ provider: 'codex', status: 'unavailable', error: 'no auth' }) }),
      { queriedAtMs: QUERIED_AT_MS }
    )
    expect(evidence.providers.codex).toMatchObject({ available: false, status: 'unavailable', windows: [] })
  })

  it('surfaces a rate-limited provider as booleans, not a raw error payload', () => {
    const retryAtMs = Date.parse('2026-09-09T13:00:00.000Z')
    const evidence = projectResourceEvidence(
      state({
        codex: provider({
          provider: 'codex',
          status: 'error',
          error: 'HTTP 429 from https://example/usage with token abc',
          usageMetadata: { failureKind: 'rate-limited', retryAtMs }
        })
      }),
      { queriedAtMs: QUERIED_AT_MS }
    )
    expect(evidence.providers.codex).toMatchObject({
      rateLimited: true,
      retryAt: '2026-09-09T13:00:00.000Z'
    })
    expect(JSON.stringify(evidence)).not.toContain('429')
    expect(JSON.stringify(evidence)).not.toContain('token abc')
  })

  it('omits providers with no state and never fabricates windows', () => {
    const evidence = projectResourceEvidence(state({}), { queriedAtMs: QUERIED_AT_MS })
    expect(Object.keys(evidence.providers)).toEqual([])
  })

  it('handles a missing source update time as null age', () => {
    const evidence = projectResourceEvidence(
      state({
        codex: provider({
          provider: 'codex',
          updatedAt: Number.NaN,
          session: window({ usedPercent: 0, windowMinutes: 300 })
        })
      }),
      { queriedAtMs: QUERIED_AT_MS }
    )
    expect(evidence.providers.codex?.sourceUpdatedAt).toBeNull()
    expect(evidence.providers.codex?.dataAgeMs).toBeNull()
  })

  it('never emits account identity fields', () => {
    const serialized = JSON.stringify(
      projectResourceEvidence(
        state({
          claude: provider({ provider: 'claude', session: window({ usedPercent: 10, windowMinutes: 300 }) }),
          inactiveClaudeAccounts: [
            { accountId: 'acct-secret', rateLimits: null, updatedAt: 1, isFetching: false }
          ]
        }),
        { queriedAtMs: QUERIED_AT_MS }
      )
    )
    for (const forbidden of ['acct-secret', 'accountId', 'email', '@', 'providerAccountId', 'organizationName']) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})
