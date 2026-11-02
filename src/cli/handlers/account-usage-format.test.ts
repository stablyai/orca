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

const SESSION = {
  usedPercent: 41,
  windowMinutes: 300,
  resetsAt: NOW + 2 * HOUR,
  resetDescription: null
}

describe('account usage rows', () => {
  it('attributes active and inactive Claude usage to each managed account', () => {
    const rows = buildAccountUsageRows(
      snapshot({
        claude: limits('claude', {
          session: SESSION,
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
              status: 'unavailable',
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
      {
        agent: 'claude',
        accountId: 'a1',
        label: 'work@example.com',
        active: true,
        status: 'ok',
        error: null,
        windows: [
          {
            name: '5h',
            usedPercent: 41,
            windowMinutes: 300,
            resetsAt: '2026-10-24T14:00:00.000Z'
          },
          {
            name: '7d',
            usedPercent: 30,
            windowMinutes: 10080,
            resetsAt: '2026-10-26T14:00:00.000Z'
          }
        ],
        updatedAt: '2026-10-24T12:00:00.000Z'
      },
      expect.objectContaining({
        accountId: 'a2',
        active: false,
        status: 'unavailable',
        error: 'Sign in again to use this account.',
        windows: []
      })
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

  it('lists a managed account whose usage was never read', () => {
    const rows = buildAccountUsageRows(snapshot({ claude: limits('claude', { session: SESSION }) }))

    expect(rows.find((row) => row.accountId === 'a2')).toEqual({
      agent: 'claude',
      accountId: 'a2',
      label: 'home@example.com',
      active: false,
      status: 'unavailable',
      error: 'No usage read yet; run with --fresh.',
      windows: [],
      updatedAt: null
    })
    expect(formatAccountUsage(rows, NOW)).toBe(
      [
        'Claude',
        '  work@example.com (active)  5h 41% (resets in 2h 0m)',
        '  home@example.com           No usage read yet; run with --fresh.'
      ].join('\n')
    )
  })

  it('does not point back to --fresh for an account the host had read within the last minute', () => {
    const rows = buildAccountUsageRows(
      snapshot({ claude: limits('claude', { session: SESSION }) }),
      {
        fresh: true
      }
    )

    expect(rows.find((row) => row.accountId === 'a2')?.error).toBe(
      'No usage read yet; Orca reads unselected accounts at most once a minute, so try again shortly.'
    )
    expect(rows.find((row) => row.accountId === 'a1')?.error).toBeNull()
  })

  it('attributes the active usage to the account selected for the WSL rate-limit target', () => {
    const base = snapshot({
      claude: limits('claude', { session: SESSION }),
      claudeTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' }
    })
    const rows = buildAccountUsageRows({
      ...base,
      claude: {
        ...base.claude,
        activeAccountId: 'a1',
        activeAccountIdsByRuntime: { host: 'a1', wsl: { Ubuntu: 'a2' } }
      }
    })

    expect(rows.filter((row) => row.agent === 'claude')).toEqual([
      expect.objectContaining({
        accountId: 'a1',
        active: true,
        status: 'unavailable',
        error: 'Selected on another runtime; Orca reads usage for the WSL Ubuntu selection only.',
        windows: []
      }),
      expect.objectContaining({ accountId: 'a2', active: true, status: 'ok' })
    ])
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
