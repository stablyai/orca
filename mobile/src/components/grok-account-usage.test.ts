import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { decodeAccountsSnapshot } from './accounts-snapshot'
import {
  getGrokAccountUsage,
  getGrokUsageBarModel,
  hostShowsAccountUsage
} from './grok-account-usage'

const now = 1_700_000_000_000
const hour = 60 * 60 * 1000

function windowOf(usedPercent: number, windowMinutes: number, resetsAt: number | null = null) {
  return { usedPercent, windowMinutes, resetsAt, resetDescription: null }
}

function grokLimits(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'grok',
    session: null,
    weekly: null,
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

describe('getGrokAccountUsage', () => {
  it('shows a weekly Grok meter and the desktop account label', () => {
    const snapshot = decode({
      grokAuthConfigured: true,
      grok: grokLimits({
        weekly: windowOf(12, 10_080, now + 3 * hour),
        usageMetadata: { authProvenance: 'dev@example.com (SuperGrok)' }
      })
    })

    const usage = getGrokAccountUsage(snapshot)
    expect(usage).toMatchObject({
      label: 'dev@example.com (SuperGrok)',
      windowKey: 'weekly'
    })
    expect(getGrokUsageBarModel(usage!, now)).toMatchObject({
      windowLabel: '7d',
      labelWidth: 22,
      bar: { usedPercent: 12, unavailable: false, loading: false },
      resetText: 'Resets in 3h'
    })
    expect(hostShowsAccountUsage(snapshot)).toBe(true)
  })

  it('prefers weekly credits over a monthly window when both are present', () => {
    const snapshot = decode({
      grok: grokLimits({
        weekly: windowOf(4, 10_080),
        monthly: windowOf(40, 43_200)
      })
    })

    expect(getGrokAccountUsage(snapshot)?.windowKey).toBe('weekly')
  })

  it('shows monthly unified billing when there is no weekly window', () => {
    const snapshot = decode({
      grok: grokLimits({
        weekly: null,
        monthly: windowOf(25, 43_200, now + 6 * 24 * hour)
      })
    })
    const usage = getGrokAccountUsage(snapshot)

    expect(usage?.windowKey).toBe('monthly')
    expect(getGrokUsageBarModel(usage!, now)).toMatchObject({
      windowLabel: '30d',
      labelWidth: 28,
      bar: { usedPercent: 25, unavailable: false, loading: false },
      resetText: 'Resets in 6d'
    })
  })

  it('keeps a 0% weekly window visible', () => {
    const snapshot = decode({
      grok: grokLimits({ weekly: windowOf(0, 10_080) })
    })

    expect(getGrokUsageBarModel(getGrokAccountUsage(snapshot)!, now).bar.usedPercent).toBe(0)
  })

  it('shows a signed-in session before the first usage payload arrives', () => {
    const snapshot = decode({ grokAuthConfigured: true })
    const usage = getGrokAccountUsage(snapshot)

    expect(usage).toMatchObject({ label: 'Signed in', windowKey: null, limits: null })
    expect(getGrokUsageBarModel(usage!, now).bar).toEqual({
      usedPercent: null,
      unavailable: false,
      loading: true
    })
  })

  it('keeps the last weekly meter when a later refresh errors', () => {
    const snapshot = decode({
      grok: grokLimits({
        status: 'error',
        error: 'temporarily unavailable',
        weekly: windowOf(72, 10_080)
      })
    })
    const usage = getGrokAccountUsage(snapshot)

    expect(usage?.limits?.error).toBe('temporarily unavailable')
    expect(getGrokUsageBarModel(usage!, now).bar).toEqual({
      usedPercent: 72,
      unavailable: false,
      loading: false
    })
  })

  it('shows an expired session that has no window yet', () => {
    const snapshot = decode({
      grokAuthConfigured: true,
      grok: grokLimits({
        status: 'error',
        error: 'Grok sign-in expired',
        weekly: null
      })
    })
    const usage = getGrokAccountUsage(snapshot)

    expect(usage?.label).toBe('Signed in')
    expect(getGrokUsageBarModel(usage!, now).bar).toEqual({
      usedPercent: null,
      unavailable: true,
      loading: false
    })
  })

  it('hides Grok when the host is not signed in and has no meter', () => {
    const snapshot = decode({
      grok: grokLimits({ status: 'unavailable', error: 'Not signed in to Grok', weekly: null })
    })

    expect(getGrokAccountUsage(snapshot)).toBeNull()
    expect(hostShowsAccountUsage(snapshot)).toBe(false)
  })

  it('ignores a malformed Grok slot without dropping Claude', () => {
    const snapshot = decode({
      claude: grokLimits({ provider: 'claude', status: 'ok', session: windowOf(10, 300) }),
      grok: { provider: 'grok', status: 'ok' }
    })

    expect(snapshot.rateLimits.claude?.status).toBe('ok')
    expect(getGrokAccountUsage(snapshot)).toBeNull()
  })

  it('ignores a Grok slot stamped with another provider', () => {
    const snapshot = decode({
      grokAuthConfigured: true,
      grok: grokLimits({ provider: 'claude', weekly: windowOf(90, 10_080) })
    })
    const usage = getGrokAccountUsage(snapshot)

    expect(usage?.limits).toBeNull()
    expect(usage?.windowKey).toBeNull()
  })

  it('still shows the home card for Claude when Grok is absent', () => {
    const snapshot = decodeAccountsSnapshot({
      claude: {
        accounts: [{ id: 'claude-1', email: 'dev@example.com' }],
        activeAccountId: 'claude-1'
      },
      codex: { accounts: [], activeAccountId: null },
      rateLimits: {
        claude: null,
        codex: null,
        inactiveClaudeAccounts: [],
        inactiveCodexAccounts: []
      }
    })

    expect(getGrokAccountUsage(snapshot)).toBeNull()
    expect(hostShowsAccountUsage(snapshot)).toBe(true)
  })
})

describe('Grok usage wiring', () => {
  it('includes Grok in the home list and mounts it on the accounts screen', () => {
    const homeData = readFileSync(
      new URL('../home/use-mobile-home-data.ts', import.meta.url),
      'utf8'
    )
    const accounts = readFileSync(
      new URL('../../app/h/[hostId]/accounts.tsx', import.meta.url),
      'utf8'
    )

    expect(homeData).toContain('hostShowsAccountUsage(snapshot)')
    expect(accounts).toContain('<GrokAccountUsageSection')
  })
})
