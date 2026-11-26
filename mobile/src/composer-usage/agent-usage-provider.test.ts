import { describe, expect, it } from 'vitest'
import { decodeAccountsSnapshot } from '../accounts/accounts-snapshot'
import {
  composerUsageWindowToggleChoices,
  listProviderUsages,
  pickComposerUsageWindow,
  readUsageWindowHistory,
  selectAgentUsage,
  selectProviderUsage
} from './agent-usage-provider'

const window = (usedPercent: number, windowMinutes: number) => ({
  usedPercent,
  windowMinutes,
  resetsAt: null,
  resetDescription: null
})
const limits = (provider: string, extra: Record<string, unknown>) => ({
  provider,
  session: null,
  weekly: null,
  updatedAt: 1,
  error: null,
  status: 'ok',
  ...extra
})
const snapshot = decodeAccountsSnapshot({
  claude: { accounts: [], activeAccountId: null },
  codex: { accounts: [], activeAccountId: null },
  rateLimits: {
    claude: limits('claude', { session: window(20, 300), weekly: window(55, 10080) }),
    codex: null,
    gemini: null,
    opencodeGo: limits('opencode-go', { monthly: window(12, 43200) }),
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
})

describe('selectAgentUsage', () => {
  it('maps agent ids to their provider and hides agents without usage', () => {
    expect(selectAgentUsage(snapshot, 'claude-agent-teams')?.provider).toBe('claude')
    expect(selectAgentUsage(snapshot, 'codex')).toBeNull()
    expect(selectAgentUsage(snapshot, 'gemini')).toBeNull()
    expect(selectAgentUsage(snapshot, 'aider')).toBeNull()
    expect(selectAgentUsage(snapshot, null)).toBeNull()
  })

  it('falls back to the window a provider has when the chosen one is missing', () => {
    const claude = selectAgentUsage(snapshot, 'claude')?.windows ?? []
    expect(pickComposerUsageWindow(claude, 'weekly')?.window.usedPercent).toBe(55)
    const opencode = selectAgentUsage(snapshot, 'opencode')?.windows ?? []
    expect(pickComposerUsageWindow(opencode, 'session')?.kind).toBe('monthly')
  })

  it('offers the 5-hour toggle only when that provider has a 5-hour window and a weekly window', () => {
    const claude = selectAgentUsage(snapshot, 'claude')?.windows ?? []
    expect(composerUsageWindowToggleChoices(claude)).toEqual(['session', 'weekly'])
    expect(
      composerUsageWindowToggleChoices(claude.filter((entry) => entry.kind !== 'session'))
    ).toEqual([])
    expect(
      composerUsageWindowToggleChoices(claude.filter((entry) => entry.kind !== 'weekly'))
    ).toEqual([])
  })

  it('maps the Muse and zcode agents to their providers', () => {
    const withMuse = decodeAccountsSnapshot({
      claude: { accounts: [], activeAccountId: null },
      codex: { accounts: [], activeAccountId: null },
      rateLimits: {
        claude: null,
        codex: null,
        muse: limits('muse', { session: window(0, 300) }),
        zcode: limits('zcode', { monthly: window(12, 43200) }),
        inactiveClaudeAccounts: [],
        inactiveCodexAccounts: []
      }
    })
    expect(selectAgentUsage(withMuse, 'muse')?.provider).toBe('muse')
    expect(selectAgentUsage(withMuse, 'zcode')?.provider).toBe('zcode')
  })
})

describe('listProviderUsages', () => {
  it('lists every provider with windows, the given one first', () => {
    expect(listProviderUsages(snapshot, 'claude').map((usage) => usage.provider)).toEqual([
      'claude',
      'opencode-go'
    ])
    expect(listProviderUsages(snapshot, 'opencode-go').map((usage) => usage.provider)).toEqual([
      'opencode-go',
      'claude'
    ])
  })

  it('lists nothing without a snapshot', () => {
    expect(listProviderUsages(null, 'claude')).toEqual([])
  })
})

describe('readUsageWindowHistory', () => {
  const withHistory = decodeAccountsSnapshot({
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: limits('claude', { session: window(20, 300), weekly: window(55, 10080) }),
      codex: null,
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: [],
      usageHistory: {
        'claude:weekly': {
          resetsAt: null,
          windowMinutes: 10080,
          samples: [
            { at: 200, usedPercent: 12 },
            { at: 100, usedPercent: 10 }
          ]
        }
      }
    }
  })

  it("reads one window's samples oldest first", () => {
    expect(readUsageWindowHistory(withHistory, 'claude', 'weekly')).toEqual([
      { at: 100, usedPercent: 10 },
      { at: 200, usedPercent: 12 }
    ])
    expect(readUsageWindowHistory(withHistory, 'claude', 'session')).toEqual([])
    expect(readUsageWindowHistory(withHistory, 'codex', 'weekly')).toEqual([])
  })

  it('is empty on hosts that keep none', () => {
    expect(readUsageWindowHistory(snapshot, 'claude', 'weekly')).toEqual([])
    expect(readUsageWindowHistory(null, 'claude', 'weekly')).toEqual([])
  })
})

describe('usage notice', () => {
  const NOTICE = 'Muse has no usage data for this window yet; it appears after your first Muse turn'
  const museSnapshot = (muse: Record<string, unknown>) =>
    decodeAccountsSnapshot({
      claude: { accounts: [], activeAccountId: null },
      codex: { accounts: [], activeAccountId: null },
      rateLimits: {
        claude: null,
        codex: null,
        muse,
        inactiveClaudeAccounts: [],
        inactiveCodexAccounts: []
      }
    })

  it('carries the host note beside the windows, e.g. Muse before its first turn', () => {
    const usage = selectProviderUsage(
      museSnapshot({
        provider: 'muse',
        session: { usedPercent: 0, windowMinutes: 300, resetsAt: null, resetDescription: null },
        weekly: null,
        updatedAt: 1,
        error: null,
        notice: NOTICE,
        status: 'ok'
      }),
      'muse'
    )
    expect(usage?.notice).toBe(NOTICE)
    expect(usage?.windows).toHaveLength(1)
    expect(usage?.windows[0]?.window.usedPercent).toBe(0)
  })

  it('still hides a provider whose reading has no windows', () => {
    expect(
      selectProviderUsage(
        museSnapshot({
          provider: 'muse',
          session: null,
          weekly: null,
          updatedAt: 1,
          error: 'Muse usage is unavailable.',
          status: 'unavailable'
        }),
        'muse'
      )
    ).toBeNull()
  })
})
