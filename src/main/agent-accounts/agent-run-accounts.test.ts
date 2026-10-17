import { describe, expect, it } from 'vitest'
import type { AgentRunAccount } from '../../shared/agent-run-account'
import type { CodexPaneAccountRecord } from '../codex/codex-pane-account-registry'
import type { ClaudeManagedAccount, CodexManagedAccount } from '../../shared/managed-account-types'
import type { KeptConversation } from './kept-agent-conversations'
import { computeAgentRunAccount, type AgentRunAccountInput } from './agent-run-account-compute'
import {
  AgentRunAccounts,
  type AgentRunAccountSettings,
  type AgentRunAccountStatusRow
} from './agent-run-accounts'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const DATA = '/data'
const SYSTEM_HOME = '/home/user/.claude'

function input(overrides: Partial<AgentRunAccountInput>): AgentRunAccountInput {
  return {
    agentType: 'codex',
    connectionId: null,
    structured: false,
    providerSessionId: 's1',
    hasManagedAccounts: true,
    lane: 'host',
    codexRecord: null,
    claude: null,
    current: undefined,
    claudeKeptAccountId: undefined,
    ...overrides
  }
}

const ACCOUNT_HOME_RECORD: CodexPaneAccountRecord = {
  selectionKey: 'host',
  accountId: 'acc-a',
  homeRoute: 'account-home'
}

const CLAUDE_FOLLOW_A: AgentRunAccount = {
  provider: 'claude',
  lane: 'host',
  accountId: 'acc-a',
  mode: 'follow',
  shellRoute: 'account'
}

describe('computeAgentRunAccount', () => {
  it.each<[string, Partial<AgentRunAccountInput>, AgentRunAccount | null]>([
    [
      'a Codex pane that follows',
      { codexRecord: ACCOUNT_HOME_RECORD },
      { provider: 'codex', lane: 'host', accountId: 'acc-a', mode: 'follow' }
    ],
    [
      'a kept Codex pane',
      { codexRecord: { ...ACCOUNT_HOME_RECORD, kept: true } },
      { provider: 'codex', lane: 'host', accountId: 'acc-a', mode: 'kept' }
    ],
    [
      'a Codex pane on the shared home',
      { codexRecord: { selectionKey: 'host', accountId: null, homeRoute: 'shared-home' } },
      {
        provider: 'codex',
        lane: 'host',
        accountId: null,
        mode: 'follow',
        keepUnavailable: 'codex-home-not-keepable'
      }
    ],
    [
      'a WSL Codex record',
      { codexRecord: { ...ACCOUNT_HOME_RECORD, selectionKey: 'wsl:U' } },
      null
    ],
    ['a Codex pane with no record and no facet', {}, null],
    ['a relay row', { connectionId: 'ssh-1', codexRecord: ACCOUNT_HOME_RECORD }, null],
    ['a structured row', { structured: true, codexRecord: ACCOUNT_HOME_RECORD }, null],
    [
      'a provider with no saved accounts',
      { hasManagedAccounts: false, codexRecord: ACCOUNT_HOME_RECORD },
      null
    ],
    ['a pane launched on a WSL lane', { lane: 'wsl:U', codexRecord: ACCOUNT_HOME_RECORD }, null],
    ['another agent', { agentType: 'gemini', codexRecord: ACCOUNT_HOME_RECORD }, null],
    [
      'a Claude session this runtime saw start',
      { agentType: 'claude', claude: { accountId: 'acc-a', shellRoute: 'selected' } },
      {
        provider: 'claude',
        lane: 'host',
        accountId: 'acc-a',
        mode: 'follow',
        shellRoute: 'selected'
      }
    ],
    [
      'a Claude session nobody saw start',
      { agentType: 'claude', claude: { accountId: undefined, shellRoute: 'selected' } },
      null
    ],
    [
      'a Claude statusline from a folder no account owns',
      {
        agentType: 'claude',
        claude: { accountId: 'acc-a', statusLine: 'unknown-folder', shellRoute: 'selected' }
      },
      null
    ],
    [
      'a Claude statusline correcting the start account',
      {
        agentType: 'claude',
        claude: {
          accountId: 'acc-a',
          statusLine: { accountId: 'acc-b' },
          shellRoute: 'selected'
        }
      },
      {
        provider: 'claude',
        lane: 'host',
        accountId: 'acc-b',
        mode: 'follow',
        shellRoute: 'selected'
      }
    ],
    [
      'a Claude pane with no session yet',
      {
        agentType: 'claude',
        providerSessionId: null,
        claude: { accountId: 'acc-a', shellRoute: 'account' }
      },
      {
        provider: 'claude',
        lane: 'host',
        accountId: 'acc-a',
        mode: 'follow',
        shellRoute: 'account',
        keepUnavailable: 'no-session'
      }
    ],
    [
      'a kept Claude conversation on its account',
      {
        agentType: 'claude',
        claude: { accountId: 'acc-a', shellRoute: 'account' },
        claudeKeptAccountId: 'acc-a'
      },
      { provider: 'claude', lane: 'host', accountId: 'acc-a', mode: 'kept', shellRoute: 'account' }
    ],
    [
      'a Claude conversation kept elsewhere than it runs',
      {
        agentType: 'claude',
        claude: { accountId: 'acc-b', shellRoute: 'selected' },
        claudeKeptAccountId: 'acc-a'
      },
      {
        provider: 'claude',
        lane: 'host',
        accountId: 'acc-b',
        mode: 'follow',
        shellRoute: 'selected',
        keptElsewhere: true
      }
    ],
    [
      'a kept System default Claude conversation that runs on an account',
      {
        agentType: 'claude',
        claude: { accountId: 'acc-b', shellRoute: 'selected' },
        claudeKeptAccountId: null
      },
      {
        provider: 'claude',
        lane: 'host',
        accountId: 'acc-b',
        mode: 'follow',
        shellRoute: 'selected',
        keptElsewhere: true
      }
    ],
    [
      'a Claude pane with no session yet, which has no keep to name',
      {
        agentType: 'claude',
        providerSessionId: null,
        claude: { accountId: 'acc-b', shellRoute: 'selected' },
        claudeKeptAccountId: 'acc-a'
      },
      {
        provider: 'claude',
        lane: 'host',
        accountId: 'acc-b',
        mode: 'follow',
        shellRoute: 'selected',
        keepUnavailable: 'no-session'
      }
    ],
    [
      'a Claude pane this runtime has not seen, with the facet an earlier runtime recorded',
      { agentType: 'claude', current: CLAUDE_FOLLOW_A },
      CLAUDE_FOLLOW_A
    ],
    [
      'a Claude pane this runtime has not seen, whose conversation is kept on its account',
      { agentType: 'claude', current: CLAUDE_FOLLOW_A, claudeKeptAccountId: 'acc-a' },
      { ...CLAUDE_FOLLOW_A, mode: 'kept' }
    ],
    [
      'a Claude pane this runtime has not seen, whose keep was released since it was recorded',
      { agentType: 'claude', current: { ...CLAUDE_FOLLOW_A, mode: 'kept' } },
      CLAUDE_FOLLOW_A
    ],
    [
      'a Claude pane this runtime has not seen, whose conversation is now kept elsewhere',
      { agentType: 'claude', current: CLAUDE_FOLLOW_A, claudeKeptAccountId: 'acc-b' },
      { ...CLAUDE_FOLLOW_A, keptElsewhere: true }
    ],
    [
      'a Claude pane this runtime has not seen, with no facet recorded',
      { agentType: 'claude' },
      null
    ],
    [
      "a Claude pane this runtime has not seen, whose recorded facet is Codex's",
      {
        agentType: 'claude',
        current: { provider: 'codex', lane: 'host', accountId: 'acc-a', mode: 'kept' }
      },
      null
    ]
  ])('%s', (_label, overrides, expected) => {
    expect(computeAgentRunAccount(input(overrides))).toEqual(expected)
  })

  it('keeps a persisted Codex facet until the launch record can be read', () => {
    const current: AgentRunAccount = {
      provider: 'codex',
      lane: 'host',
      accountId: 'acc-a',
      mode: 'kept'
    }
    expect(computeAgentRunAccount(input({ current }))).toEqual(current)
  })
})

function claudeAccount(id: string): ClaudeManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedAuthPath: `${DATA}/claude-accounts/${id}`,
    authMethod: 'subscription-oauth',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

function codexAccount(id: string): CodexManagedAccount {
  return {
    id,
    email: `${id}@example.com`,
    managedHomePath: `${DATA}/codex-accounts/${id}/home`,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

type Harness = {
  kept: Map<string, KeptConversation>
  producer: AgentRunAccounts
  rows: Map<string, AgentRunAccountStatusRow>
  settings: AgentRunAccountSettings
  records: Map<string, CodexPaneAccountRecord>
  covered: Set<string>
  republished: (AgentRunAccount | null)[]
  emit: (row: Partial<AgentRunAccountStatusRow> & { sessionId?: string | null }) => void
}

function harness(): Harness {
  const rows = new Map<string, AgentRunAccountStatusRow>()
  const records = new Map<string, CodexPaneAccountRecord>()
  const covered = new Set<string>()
  const republished: (AgentRunAccount | null)[] = []
  const kept = new Map<string, KeptConversation>()
  const settings: AgentRunAccountSettings = {
    claudeManagedAccounts: [claudeAccount('acc-a'), claudeAccount('acc-b')],
    codexManagedAccounts: [codexAccount('acc-a')],
    activeClaudeManagedAccountId: 'acc-a',
    activeClaudeManagedAccountIdsByRuntime: undefined
  }
  const producer = new AgentRunAccounts({
    republish: (paneKey, runAccount) => {
      const row = rows.get(paneKey)
      if (row) {
        rows.set(paneKey, { ...row, runAccount })
      }
      republished.push(runAccount)
      return true
    },
    getRow: (paneKey) => {
      const row = rows.get(paneKey)
      return row
        ? {
            paneKey,
            agentType: row.payload.agentType,
            providerSession: row.providerSession,
            runAccount: row.runAccount ?? undefined,
            connectionId: row.connectionId
          }
        : null
    },
    listRows: () => [...rows.values()],
    getSettings: () => settings,
    getPtyIdForPaneKey: (paneKey) => (paneKey === PANE ? 'pty-1' : undefined),
    readCodexRecord: (ptyId) => records.get(ptyId) ?? null,
    claudeFolders: {
      accountHome: (id) => `${DATA}/claude-profiles/${id}/home`,
      systemDefaultHome: () => SYSTEM_HOME,
      coveredBySystemDefault: (id) => covered.has(id)
    },
    kept: {
      get: (provider, sessionId) => kept.get(`${provider}:${sessionId}`) ?? null,
      keep: (provider, sessionId, entry) => {
        kept.set(`${provider}:${sessionId}`, entry)
      },
      releaseCarried: (provider, sessionId, keptAt) => {
        if (kept.get(`${provider}:${sessionId}`)?.keptAt === keptAt) {
          kept.delete(`${provider}:${sessionId}`)
        }
      }
    },
    now: () => 42
  })
  const emit: Harness['emit'] = ({ sessionId = 's1', ...overrides }) => {
    const previous = rows.get(PANE)
    const row: AgentRunAccountStatusRow = {
      paneKey: PANE,
      connectionId: null,
      payload: { agentType: 'claude' },
      ...(sessionId ? { providerSession: { key: 'session_id', id: sessionId } } : {}),
      ...(previous?.runAccount !== undefined ? { runAccount: previous.runAccount } : {}),
      ...overrides
    }
    rows.set(PANE, row)
    producer.noteStatus(row)
  }
  return { kept, producer, rows, settings, records, covered, republished, emit }
}

function facet(h: Harness): AgentRunAccount | null | undefined {
  return h.rows.get(PANE)?.runAccount
}

describe('AgentRunAccounts', () => {
  it('dates a Claude session to the selection when this runtime saw it start', () => {
    const h = harness()
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: true })
    h.emit({})
    expect(facet(h)).toMatchObject({ accountId: 'acc-a', shellRoute: 'selected', mode: 'follow' })

    // A switch moves the next start, not the running session.
    h.settings.activeClaudeManagedAccountId = 'acc-b'
    h.emit({})
    expect(facet(h)).toMatchObject({ accountId: 'acc-a' })

    h.emit({ sessionId: 's2' })
    expect(facet(h)).toMatchObject({ accountId: 'acc-b' })
  })

  it('claims nothing for a session that was already running when it was first seen', () => {
    const h = harness()
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: false })
    h.emit({})
    expect(facet(h)).toBeUndefined()
    expect(h.republished).toEqual([])

    h.producer.noteClaudeStatusLine({
      paneKey: PANE,
      configDir: `${DATA}/claude-profiles/acc-b/home`
    })
    expect(facet(h)).toMatchObject({ accountId: 'acc-b' })
  })

  it('keeps the facet a previous runtime recorded for the same session', () => {
    const h = harness()
    const persisted: AgentRunAccount = {
      provider: 'claude',
      lane: 'host',
      accountId: 'acc-b',
      mode: 'follow',
      shellRoute: 'selected'
    }
    h.emit({ runAccount: persisted })
    expect(facet(h)).toEqual(persisted)
    expect(h.republished).toEqual([])
  })

  it('withdraws the facet when the statusline names a folder no account owns', () => {
    const h = harness()
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: true })
    h.emit({})
    h.producer.noteClaudeStatusLine({ paneKey: PANE, configDir: '/somewhere/else' })
    expect(facet(h)).toBeNull()
  })

  it('maps System default to the start account only while that account is covered', () => {
    const h = harness()
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: true })
    h.emit({})
    h.producer.noteClaudeStatusLine({ paneKey: PANE, configDir: null })
    expect(facet(h)).toMatchObject({ accountId: null })

    h.covered.add('acc-a')
    h.producer.noteClaudeStatusLine({ paneKey: PANE, configDir: SYSTEM_HOME })
    expect(facet(h)).toMatchObject({ accountId: 'acc-a' })
  })

  it('reads a pane started on an account pointer from that pointer, not the selection', () => {
    const h = harness()
    h.producer.notePaneLaunch({
      paneKey: PANE,
      lane: 'host',
      fresh: true,
      claudeShellAccount: { accountId: 'acc-b' }
    })
    h.emit({})
    expect(facet(h)).toMatchObject({ accountId: 'acc-b', shellRoute: 'account' })
    h.emit({ sessionId: 's2' })
    expect(facet(h)).toMatchObject({ accountId: 'acc-b', shellRoute: 'account' })
  })

  it('publishes nothing for a Claude pane launched on a WSL lane', () => {
    const h = harness()
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'wsl:Ubuntu', fresh: true })
    h.emit({})
    expect(facet(h)).toBeUndefined()
  })

  it('follows the Codex launch record, including a later keep', () => {
    const h = harness()
    h.records.set('pty-1', ACCOUNT_HOME_RECORD)
    h.emit({ payload: { agentType: 'codex' } })
    expect(facet(h)).toEqual({
      provider: 'codex',
      lane: 'host',
      accountId: 'acc-a',
      mode: 'follow'
    })

    h.records.set('pty-1', { ...ACCOUNT_HOME_RECORD, kept: true })
    expect(h.producer.refresh(PANE)).toMatchObject({ mode: 'kept' })
    expect(facet(h)).toMatchObject({ mode: 'kept' })
  })

  it('withdraws every facet once a provider has no saved accounts left', () => {
    const h = harness()
    h.records.set('pty-1', ACCOUNT_HOME_RECORD)
    h.emit({ payload: { agentType: 'codex' } })
    h.settings.codexManagedAccounts = []
    h.producer.refreshAll()
    expect(facet(h)).toBeNull()
  })

  it('carries a keep to the next session when it runs on the kept account', () => {
    const h = harness()
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: true })
    h.emit({})
    h.kept.set('claude:s1', { lane: 'host', accountId: 'acc-a', keptAt: 1 })
    h.emit({})
    expect(facet(h)).toMatchObject({ mode: 'kept', accountId: 'acc-a' })

    h.emit({ sessionId: 's2' })
    expect(h.kept.get('claude:s2')).toEqual({
      lane: 'host',
      accountId: 'acc-a',
      keptAt: 42,
      keptVia: 'claude:s1'
    })
    expect(facet(h)).toMatchObject({ mode: 'kept', accountId: 'acc-a' })
  })

  it('never carries a keep to a session that runs on another account', () => {
    const h = harness()
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: true })
    h.emit({})
    h.kept.set('claude:s1', { lane: 'host', accountId: 'acc-a', keptAt: 1 })

    // A `claude` typed after a switch in a selection-following terminal runs on the selection.
    h.settings.activeClaudeManagedAccountId = 'acc-b'
    h.emit({ sessionId: 's2' })

    expect(h.kept.has('claude:s2')).toBe(false)
    expect(facet(h)).toMatchObject({ mode: 'follow', accountId: 'acc-b' })
  })

  it('carries a keep through /clear after a switch, inside the same Claude process', () => {
    const h = harness()
    const process = { pid: 4242, platform: 'linux', startTime: 'boot-1' } as const
    const presence = { agentPresence: { agent: 'claude', process } } as const
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: true })
    h.emit({ ...presence })
    h.kept.set('claude:s1', { lane: 'host', accountId: 'acc-a', keptAt: 1 })
    h.settings.activeClaudeManagedAccountId = 'acc-b'

    h.emit({ sessionId: 's2', ...presence })

    expect(h.kept.get('claude:s2')).toMatchObject({ accountId: 'acc-a', keptVia: 'claude:s1' })
    expect(facet(h)).toMatchObject({ mode: 'kept', accountId: 'acc-a' })
  })

  it('carries a keep through /clear once the statusline proves the kept account', () => {
    const h = harness()
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: true })
    h.emit({})
    h.kept.set('claude:s1', { lane: 'host', accountId: 'acc-a', keptAt: 1 })
    h.settings.activeClaudeManagedAccountId = 'acc-b'
    // No process identity: s2 is dated to the selection until its folder is known.
    h.emit({ sessionId: 's2' })
    expect(h.kept.has('claude:s2')).toBe(false)

    h.producer.noteClaudeStatusLine({
      paneKey: PANE,
      configDir: `${DATA}/claude-profiles/acc-a/home`
    })

    expect(h.kept.get('claude:s2')).toMatchObject({ accountId: 'acc-a', keptVia: 'claude:s1' })
    expect(facet(h)).toMatchObject({ mode: 'kept', accountId: 'acc-a' })
  })

  it('drops a carried keep the statusline proves runs on another account', () => {
    const h = harness()
    const old = {
      agentPresence: { agent: 'claude', process: { pid: 7, platform: 'linux', startTime: 'a' } }
    } as const
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: true })
    h.emit({ ...old })
    h.kept.set('claude:s1', { lane: 'host', accountId: 'acc-a', keptAt: 1 })
    h.settings.activeClaudeManagedAccountId = 'acc-b'
    // A new claude whose hooks still name the old, unended owner looks like the same process.
    h.emit({ sessionId: 's2', ...old })
    expect(h.kept.get('claude:s2')).toMatchObject({ accountId: 'acc-a' })

    h.producer.noteClaudeStatusLine({
      paneKey: PANE,
      configDir: `${DATA}/claude-profiles/acc-b/home`
    })

    expect(h.kept.has('claude:s2')).toBe(false)
    expect(h.kept.has('claude:s1')).toBe(true)
    expect(facet(h)).toMatchObject({ mode: 'follow', accountId: 'acc-b' })
  })

  it('never carries a keep to a new Claude process typed after a switch', () => {
    const h = harness()
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: true })
    h.emit({
      agentPresence: { agent: 'claude', process: { pid: 7, platform: 'linux', startTime: 'a' } }
    })
    h.kept.set('claude:s1', { lane: 'host', accountId: 'acc-a', keptAt: 1 })
    h.settings.activeClaudeManagedAccountId = 'acc-b'

    h.emit({
      sessionId: 's2',
      agentPresence: { agent: 'claude', process: { pid: 8, platform: 'linux', startTime: 'b' } }
    })

    expect(h.kept.has('claude:s2')).toBe(false)
    expect(facet(h)).toMatchObject({ mode: 'follow', accountId: 'acc-b' })
  })

  it('never carries a Claude keep to another agent in the same pane', () => {
    const h = harness()
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: true })
    h.emit({})
    h.kept.set('claude:s1', { lane: 'host', accountId: 'acc-a', keptAt: 1 })
    h.records.set('pty-1', ACCOUNT_HOME_RECORD)

    h.emit({ sessionId: 's9', payload: { agentType: 'codex' } })

    expect([...h.kept.keys()]).toEqual(['claude:s1'])
  })

  it('keeps the renamed session of a kept start', () => {
    const h = harness()
    h.kept.set('claude:resumed', { lane: 'host', accountId: 'acc-b', keptAt: 1 })
    h.producer.notePaneLaunch({
      paneKey: PANE,
      lane: 'host',
      fresh: true,
      claudeShellAccount: { accountId: 'acc-b' },
      resumedSessionId: 'resumed'
    })

    h.emit({ sessionId: 'renamed' })

    expect(h.kept.get('claude:renamed')).toMatchObject({ accountId: 'acc-b' })
    expect(facet(h)).toMatchObject({ mode: 'kept', accountId: 'acc-b', shellRoute: 'account' })
  })

  it('keeps every session a kept Codex pane reports, each traced to the first', () => {
    const h = harness()
    h.records.set('pty-1', { ...ACCOUNT_HOME_RECORD, kept: true })
    h.emit({ sessionId: 'c1', payload: { agentType: 'codex' } })
    h.emit({ sessionId: 'c2', payload: { agentType: 'codex' } })
    h.emit({ sessionId: 'c3', payload: { agentType: 'codex' } })

    expect(h.kept.get('codex:c1')).toMatchObject({ accountId: 'acc-a' })
    expect(h.kept.get('codex:c1')).not.toHaveProperty('keptVia')
    expect(h.kept.get('codex:c2')).toMatchObject({ accountId: 'acc-a', keptVia: 'codex:c1' })
    expect(h.kept.get('codex:c3')).toMatchObject({ accountId: 'acc-a', keptVia: 'codex:c1' })
  })

  it('marks a conversation kept on another account than the one it now runs on', () => {
    const h = harness()
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: true })
    h.emit({})
    h.kept.set('claude:s1', { lane: 'host', accountId: 'acc-a', keptAt: 1 })
    h.emit({})
    expect(facet(h)).toMatchObject({ mode: 'kept', accountId: 'acc-a' })
    expect(facet(h)).not.toHaveProperty('keptElsewhere')

    // A person resumes it by hand in a selection-following terminal, and the folder proves it.
    h.producer.noteClaudeStatusLine({
      paneKey: PANE,
      configDir: `${DATA}/claude-profiles/acc-b/home`
    })
    expect(facet(h)).toMatchObject({ mode: 'follow', accountId: 'acc-b', keptElsewhere: true })
    // Why: only a carried keep is dropped for running elsewhere; a person's own stays.
    expect(h.kept.get('claude:s1')).toMatchObject({ accountId: 'acc-a' })

    h.kept.delete('claude:s1')
    h.producer.refresh(PANE)
    expect(facet(h)).toMatchObject({ mode: 'follow', accountId: 'acc-b' })
    expect(facet(h)).not.toHaveProperty('keptElsewhere')
  })
})

describe('AgentRunAccounts for a Claude terminal that outlived a restart', () => {
  const keptFacet: AgentRunAccount = {
    provider: 'claude',
    lane: 'host',
    accountId: 'acc-a',
    mode: 'kept',
    shellRoute: 'selected'
  }

  // The host hydrated the row with the facet it persisted; the idle agent has posted nothing since.
  function hydrated(runAccount: AgentRunAccount = keptFacet): Harness {
    const h = harness()
    h.kept.set('claude:s1', { lane: 'host', accountId: 'acc-a', keptAt: 1 })
    h.rows.set(PANE, {
      paneKey: PANE,
      connectionId: null,
      payload: { agentType: 'claude' },
      providerSession: { key: 'session_id', id: 's1' },
      runAccount
    })
    return h
  }

  it('keeps its kept facet when the terminal reattaches', () => {
    const h = hydrated()
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: false })
    expect(facet(h)).toEqual(keptFacet)
    expect(h.republished).toEqual([])
  })

  it('keeps its kept facet when an account is added or removed', () => {
    const h = hydrated()
    h.producer.refreshAll()
    expect(facet(h)).toEqual(keptFacet)
    expect(h.republished).toEqual([])
  })

  it('keeps its kept facet through the status that follows', () => {
    const h = hydrated()
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: false })
    h.emit({})
    expect(facet(h)).toEqual(keptFacet)
    expect(h.republished).toEqual([])
  })

  it('still shows a keep made, or released, after the restart', () => {
    const h = hydrated({ ...keptFacet, mode: 'follow' })
    h.kept.delete('claude:s1')
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: false })
    expect(facet(h)).toMatchObject({ mode: 'follow' })

    h.kept.set('claude:s1', { lane: 'host', accountId: 'acc-a', keptAt: 2 })
    expect(h.producer.refresh(PANE)).toMatchObject({ mode: 'kept' })
    expect(facet(h)).toMatchObject({ mode: 'kept' })

    h.kept.delete('claude:s1')
    expect(h.producer.refresh(PANE)).toMatchObject({ mode: 'follow' })
    expect(facet(h)).toMatchObject({ mode: 'follow' })
  })

  it('withdraws what an earlier process left when the pane is spawned fresh', () => {
    const h = hydrated()
    h.producer.notePaneLaunch({ paneKey: PANE, lane: 'host', fresh: true })
    expect(facet(h)).toBeNull()
    h.producer.refreshAll()
    expect(facet(h)).toBeNull()
  })
})
