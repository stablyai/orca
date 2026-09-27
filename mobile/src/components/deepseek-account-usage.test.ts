import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { decodeAccountsSnapshot } from './accounts-snapshot'
import { getDeepSeekAccountUsage, hasDeepSeekAccountUsage } from './deepseek-account-usage'

function deepSeekLimits(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'deepseek',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: 10,
    error: null,
    status: 'ok',
    ...overrides
  }
}

function decode(rateLimits: Record<string, unknown>) {
  return decodeAccountsSnapshot({
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: null,
      codex: null,
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: [],
      ...rateLimits
    }
  })
}

describe('getDeepSeekAccountUsage', () => {
  it('shows the remaining balance from the host usage snapshot', () => {
    const snapshot = decode({
      deepseekAuthConfigured: true,
      deepseek: deepSeekLimits({
        monthly: {
          usedPercent: 0,
          windowMinutes: 43_200,
          resetsAt: null,
          resetDescription: 'USD 110.00'
        }
      })
    })

    expect(getDeepSeekAccountUsage(snapshot)).toEqual({
      balanceLabel: 'USD 110.00',
      status: 'available',
      statusLabel: 'Balance available'
    })
    expect(hasDeepSeekAccountUsage(snapshot)).toBe(true)
  })

  it('shows configured DeepSeek while the first balance request is pending', () => {
    const snapshot = decode({ deepseekAuthConfigured: true })

    expect(getDeepSeekAccountUsage(snapshot)).toEqual({
      balanceLabel: null,
      status: 'loading',
      statusLabel: 'Checking balance…'
    })
  })

  it('shows a depleted balance state', () => {
    const snapshot = decode({
      deepseek: deepSeekLimits({
        monthly: {
          usedPercent: 100,
          windowMinutes: 43_200,
          resetsAt: null,
          resetDescription: 'USD 0.00'
        }
      })
    })

    expect(getDeepSeekAccountUsage(snapshot)).toMatchObject({
      balanceLabel: 'USD 0.00',
      status: 'depleted',
      statusLabel: 'No balance remaining'
    })
  })

  it('keeps the last balance visible while reporting a refresh error', () => {
    const snapshot = decode({
      deepseekAuthConfigured: true,
      deepseek: deepSeekLimits({
        status: 'error',
        error: 'temporary network failure',
        monthly: {
          usedPercent: 0,
          windowMinutes: 43_200,
          resetsAt: null,
          resetDescription: 'USD 72.00'
        }
      })
    })

    expect(getDeepSeekAccountUsage(snapshot)).toMatchObject({
      balanceLabel: 'USD 72.00',
      status: 'refresh-error',
      statusLabel: 'Balance refresh failed'
    })
  })

  it('hides DeepSeek when the host has no configured key and no balance window', () => {
    const snapshot = decode({ deepseek: deepSeekLimits({ monthly: null }) })

    expect(getDeepSeekAccountUsage(snapshot)).toBeNull()
  })

  it('ignores a malformed DeepSeek slot without dropping Claude usage', () => {
    const snapshot = decode({
      claude: {
        ...deepSeekLimits(),
        provider: 'claude',
        session: {
          usedPercent: 25,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        }
      },
      deepseek: { provider: 'claude', status: 'ok' },
      deepseekAuthConfigured: true
    })

    expect(snapshot.rateLimits.claude?.status).toBe('ok')
    expect(getDeepSeekAccountUsage(snapshot)).toMatchObject({
      balanceLabel: null,
      status: 'loading'
    })
  })
})

describe('DeepSeek usage surfaces', () => {
  it('mounts the read-only DeepSeek section on Accounts', () => {
    const accounts = readFileSync(
      new URL('../accounts/MobileAccountsScreen.tsx', import.meta.url),
      'utf8'
    )
    const section = readFileSync(
      new URL('../accounts/DeepSeekAccountUsageSection.tsx', import.meta.url),
      'utf8'
    )

    expect(accounts).toContain('<DeepSeekAccountUsageSection snapshot={snapshot} />')
    expect(section).toContain('getDeepSeekAccountUsage(snapshot)')
  })
})
