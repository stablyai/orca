import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits, RateLimitState } from '../../shared/rate-limit-types'
import {
  type AccountsUsageSnapshot,
  buildAccountUsageRows,
  formatAccountUsage
} from './account-usage-format'

const NOW = Date.UTC(2026, 9, 24, 12, 0)
const HOUR = 3_600_000

function limits(
  provider: ProviderRateLimits['provider'],
  overrides: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: NOW,
    error: null,
    status: 'ok',
    ...overrides
  }
}

function snapshot(rateLimits: Partial<RateLimitState>): AccountsUsageSnapshot {
  return {
    claude: {
      accounts: [
        {
          id: 'a1',
          email: 'work@example.com',
          authMethod: 'subscription-oauth',
          createdAt: 0,
          updatedAt: 0,
          lastAuthenticatedAt: 0
        },
        {
          id: 'a2',
          email: 'home@example.com',
          authMethod: 'subscription-oauth',
          createdAt: 0,
          updatedAt: 0,
          lastAuthenticatedAt: 0
        }
      ],
      activeAccountId: 'a1'
    },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: null,
      codex: null,
      gemini: null,
      opencodeGo: null,
      kimi: null,
      antigravity: null,
      minimax: null,
      grok: null,
      cursor: null,
      zcode: null,
      minimaxCookieConfigured: false,
      minimaxApiKeyConfigured: false,
      opencodeGoApiKeyConfigured: false,
      grokAuthConfigured: false,
      cursorAuthConfigured: false,
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: [],
      ...rateLimits
    }
  }
}

describe('account usage rows', () => {
  it('attributes active and inactive Claude usage to each managed account', () => {
    const rows = buildAccountUsageRows(
      snapshot({
        claude: limits('claude', {
          session: {
            usedPercent: 41,
            windowMinutes: 300,
            resetsAt: NOW + 2 * HOUR,
            resetDescription: null
          },
          weekly: {
            usedPercent: 30,
            windowMinutes: 10080,
            resetsAt: NOW + 50 * HOUR,
            resetDescription: null
          }
        }),
        inactiveClaudeAccounts: [
          {
            accountId: 'a2',
            rateLimits: limits('claude', {
              status: 'error',
              error: 'Sign in again to use this account.'
            }),
            updatedAt: NOW,
            isFetching: false
          }
        ],
        codex: limits('codex', { status: 'unavailable', error: 'Codex CLI not found' })
      })
    )

    expect(rows.filter((row) => row.agent === 'claude')).toEqual([
      expect.objectContaining({
        accountId: 'a1',
        label: 'work@example.com',
        active: true,
        windows: [
          { name: '5h', usedPercent: 41, windowMinutes: 300, resetsAt: NOW + 2 * HOUR },
          { name: '7d', usedPercent: 30, windowMinutes: 10080, resetsAt: NOW + 50 * HOUR }
        ]
      }),
      expect.objectContaining({ accountId: 'a2', active: false, status: 'error', windows: [] })
    ])
    expect(formatAccountUsage(rows, NOW)).toBe(
      [
        'Claude',
        '  work@example.com (active)  5h 41% (resets in 2h 0m)  7d 30% (resets in 2d 2h)',
        '  home@example.com           Sign in again to use this account.',
        '',
        'No usage',
        '  Codex: Codex CLI not found'
      ].join('\n')
    )
  })

  it('falls back to per-model buckets only when a provider reports no main windows', () => {
    const row = buildAccountUsageRows(
      snapshot({
        gemini: limits('gemini', {
          buckets: [
            {
              name: 'Pro',
              usedPercent: 12,
              windowMinutes: 1440,
              resetsAt: null,
              resetDescription: null
            }
          ]
        })
      })
    ).find((entry) => entry.agent === 'gemini')

    expect(row?.windows).toEqual([
      { name: 'Pro', usedPercent: 12, windowMinutes: 1440, resetsAt: null }
    ])
  })
})
