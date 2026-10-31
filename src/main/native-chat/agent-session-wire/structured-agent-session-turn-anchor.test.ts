import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  liveAgentJournalTurnAnchor,
  revisedAgentJournalTurnAnchor
} from '../../../shared/agent-session-turn-record'
import { structuredAgentTurnAnchors } from '../../../shared/native-chat-turn-membership'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { resolveAgentJournalTurnRowWrite } from '../agent-session-timeline/agent-journal-turn-row-revision'
import { switchTranscriptMutations } from './structured-agent-session-switch-import-plan'

// Which prompt opened a turn is the record's identity: no writer erases it, only the live owner's
// own attribution corrects it, and a reader never takes it from where the record happens to sit.

const journals = createTrackedJournalOpener()
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-turn-anchor-'))
})
afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

const SESSION = 'claude-session'
const prompt = (uuid: string): AgentJournalItemIdentity => ({
  provider: 'claude',
  sessionId: SESSION,
  uuid
})
const record: AgentJournalItemIdentity = {
  provider: 'legacy',
  agent: 'claude',
  sessionId: SESSION,
  recordId: 'turn-lifecycle:t1'
}
const RECORD = agentJournalItemKey(record)
const P1 = agentJournalItemKey(prompt('p1'))
const P2 = agentJournalItemKey(prompt('p2'))

function open(name: string) {
  return journals.open({
    stateDirectory: root,
    identity: {
      sessionId: name,
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle(SESSION, null)
    }
  })
}

type Row = { identity: AgentJournalItemIdentity; body: AgentJournalItemBody; scope?: string }
const user = (identity: AgentJournalItemIdentity, scope?: string): Row => ({
  identity,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
  ...(scope ? { scope } : {})
})
const turnScope = (scope?: string): AgentJournalTurnScope =>
  scope ? { kind: 'turn', turnItemId: scope } : AGENT_JOURNAL_THREAD_SCOPE

/** One direct batch, through the builder every importer and the switch stop use. */
async function batch(journal: AgentSessionJournal, id: string, rows: Row[]) {
  await journal.appendPlannedLifecycleBatch({
    settlementId: id,
    fence: 1,
    plan: () => ({
      dispatches: [],
      mutations: switchTranscriptMutations(
        journal,
        rows.map(({ identity, body, scope }) => ({
          identity,
          body,
          ownerFence: 0,
          turnScope: turnScope(scope)
        }))
      )
    })
  })
}

const turnBody = (journal: AgentSessionJournal) => journal.item(RECORD)?.body

describe('the live opener policy', () => {
  const saved = new Set(['orca:opening', 'orca:steer', 'record'])
  it.each([
    ['nothing saved: the write names it', undefined, 'orca:opening', 'orca:opening'],
    ['a write naming none never erases it', 'orca:opening', undefined, 'orca:opening'],
    [
      'the owner corrects a saved steer to the opener',
      'orca:steer',
      'orca:opening',
      'orca:opening'
    ],
    ['the record itself never displaces a prompt', 'orca:opening', 'record', 'orca:opening'],
    [
      'a name no row backs never displaces a saved prompt',
      'orca:opening',
      'codex:t:0',
      'orca:opening'
    ],
    ['a record naming itself is refined', 'record', 'orca:opening', 'orca:opening']
  ])('%s', (_name, current, next, expected) => {
    expect(liveAgentJournalTurnAnchor('record', current, next, (key) => saved.has(key))).toBe(
      expected
    )
  })
})

describe('the direct-batch opener policy', () => {
  const rows = new Map([
    ['codex:t:0', 'orca:send'],
    ['orca:send', 'orca:send']
  ])
  const savedRow = (key: string) => rows.get(key)
  it.each([
    ['nothing saved: the write names it', undefined, 'orca:send', 'orca:send'],
    ['a write naming none never erases it', 'orca:send', undefined, 'orca:send'],
    ['a saved opener stands against another row', 'orca:send', 'orca:other', 'orca:send'],
    ['a saved alias resolves to its row', 'codex:t:0', 'orca:send', 'orca:send'],
    ['a record naming itself refines to its opener', 'record', 'orca:send', 'orca:send'],
    ['a prompt not saved yet refines to the opener', 'codex:late:0', 'orca:send', 'orca:send'],
    ['a provisional name stays until a write names one', 'codex:late:0', undefined, 'codex:late:0']
  ])('%s', (_name, saved, next, expected) => {
    expect(revisedAgentJournalTurnAnchor('record', saved, next, savedRow)).toBe(expected)
  })
})

describe('every writer keeps the opener a turn record names', () => {
  it('a direct batch: a real end replaces an Orca-settled record and keeps its opener', async () => {
    const journal = await open('direct')
    await batch(journal, 'stop', [
      user(prompt('p1')),
      {
        identity: record,
        body: { kind: 'turn', turnId: 't1', userItemId: P1, state: 'interrupted' }
      }
    ])
    await batch(journal, 'end', [
      { identity: record, body: { kind: 'turn', turnId: 't1', state: 'completed', completedAt: 9 } }
    ])
    expect(turnBody(journal)).toEqual({
      kind: 'turn',
      turnId: 't1',
      state: 'completed',
      completedAt: 9,
      userItemId: P1
    })
    // A later read naming another row neither moves the record nor rewrites it.
    await batch(journal, 'other', [
      user(prompt('p2')),
      { identity: record, body: { kind: 'turn', turnId: 't1', userItemId: P2, state: 'completed' } }
    ])
    expect(turnBody(journal)).toMatchObject({ userItemId: P1, completedAt: 9 })
  })

  it('a direct batch adds the opener a saved record lacks, and nothing else', async () => {
    const journal = await open('heal')
    const settled = {
      kind: 'turn' as const,
      turnId: 't1',
      state: 'interrupted' as const,
      outcome: 'cancellation' as const,
      completedAt: 5
    }
    await batch(journal, 'saved', [user(prompt('p1'), RECORD), { identity: record, body: settled }])
    await batch(journal, 'named', [
      { identity: record, body: { ...settled, completedAt: 6, userItemId: P1 } }
    ])
    expect(turnBody(journal)).toEqual({ ...settled, userItemId: P1 })
  })

  it('the revision helper: none keeps it, itself is refined, the owner corrects it', async () => {
    const journal = await open('revise')
    await batch(journal, 'rows', [
      user(prompt('p1')),
      {
        identity: record,
        body: { kind: 'turn', turnId: 't1', userItemId: RECORD, state: 'running' }
      }
    ])
    const revise = (lifecycle: Extract<AgentJournalItemBody, { kind: 'turn' }>) =>
      resolveAgentJournalTurnRowWrite(journal, { identity: record }, { lifecycle }, 64 * 1024)?.body
    // Its opener arrives late: the record names it from then on.
    expect(revise({ kind: 'turn', turnId: 't1', userItemId: P1, state: 'running' })).toMatchObject({
      userItemId: P1
    })
    await batch(journal, 'late', [
      { identity: record, body: { kind: 'turn', turnId: 't1', userItemId: P1, state: 'running' } }
    ])
    expect(revise({ kind: 'turn', turnId: 't1', state: 'completed' })).toEqual({
      kind: 'turn',
      turnId: 't1',
      state: 'completed',
      userItemId: P1
    })
    // The live owner attributes another saved prompt to this turn: that corrects the opener.
    await batch(journal, 'p2', [user(prompt('p2'))])
    expect(
      revise({ kind: 'turn', turnId: 't1', userItemId: P2, state: 'completed' })
    ).toMatchObject({ userItemId: P2 })
  })
})

describe('a reader keys a record with no opener by its own rows', () => {
  async function anchorOf(name: string, rows: Row[]) {
    const journal = await open(name)
    await batch(journal, 'rows', rows)
    return structuredAgentTurnAnchors(journal.snapshot().items).get(RECORD)
  }
  const unnamed: Row = {
    identity: record,
    body: { kind: 'turn', turnId: 't1', state: 'completed' }
  }

  it('takes the prompt scoped to it, wherever the record sits', async () => {
    expect(
      await anchorOf('scoped', [user(prompt('p1')), unnamed, user(prompt('p2'), RECORD)])
    ).toBe(P2)
  })

  it('keys itself when only replies are scoped to it, never the prompt before it', async () => {
    const reply: Row = {
      identity: prompt('r'),
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] },
      scope: RECORD
    }
    expect(await anchorOf('unopened', [user(prompt('p1')), unnamed, reply])).toBe(RECORD)
  })

  it('an older host’s record with nothing scoped to it keeps the prompt before it', async () => {
    expect(await anchorOf('legacy', [user(prompt('p1')), unnamed])).toBe(P1)
  })
})
