import { describe, expect, it } from 'vitest'
import { decodeAccountsSnapshot } from '../components/accounts-snapshot'
import { pickComposerUsageWindow, selectAgentUsage } from './agent-usage-provider'

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
    // Passthrough providers arrive unvalidated; a malformed one must hide, not crash.
    gemini: { provider: 'gemini', session: 'broken' },
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
