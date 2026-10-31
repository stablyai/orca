import { describe, expect, it } from 'vitest'
import { decodeAccountsSnapshot } from '../components/accounts-snapshot'
import {
  pickComposerUsageWindow,
  resolveComposerUsageTarget,
  selectAgentUsage
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
})

describe('resolveComposerUsageTarget', () => {
  const weeklyOnly = decodeAccountsSnapshot({
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    rateLimits: {
      claude: limits('claude', { weekly: window(70, 10080) }),
      codex: limits('codex', { weekly: window(97, 10080) }),
      gemini: null,
      grok: limits('grok', { weekly: window(22, 10080) }),
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }
  })

  it('shows an idle 5h meter instead of weekly for session providers without a session window', () => {
    const claude = selectAgentUsage(weeklyOnly, 'claude')!
    expect(resolveComposerUsageTarget(claude, 'session')).toEqual({ kind: 'no-session' })
    expect(resolveComposerUsageTarget(claude, 'weekly')?.kind).toBe('window')
  })

  it('keeps the fallback for weekly-only providers and Codex weekly-only plans', () => {
    for (const agent of ['grok', 'codex']) {
      const target = resolveComposerUsageTarget(selectAgentUsage(weeklyOnly, agent)!, 'session')
      expect(target?.kind === 'window' && target.entry.kind).toBe('weekly')
    }
  })
})
