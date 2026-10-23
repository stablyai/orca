// A relaunched host lists every restored chat as Interrupted or Done and reads none of their
// history: each row comes from the chat's record, its journal's saved open turn and the offers the
// last quit recorded. Opening a chat is what reads it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { HOST_TEST_LOCATION as LOCATION } from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { marker } from './structured-agent-session-restart-resume-test-harness'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'

const NOW = 1_800_000_000_000
const CUT = 'chat-cut-by-crash'
const DONE = 'chat-done'
/** Saved before journals kept an open turn: the quit's offer is what says it was working. */
const LEGACY_WORKING = 'chat-working-at-quit'
const NEVER_SENT = 'chat-never-sent'
const UNWRITTEN = 'chat-without-journal'

let root: string
let host: StructuredAgentSessionHost

const record = (sessionId: string): AgentSessionRecord =>
  agentSessionRecordFixture({
    sessionId,
    location: LOCATION,
    conversationName: `name of ${sessionId}`,
    providerHandleChain: [
      {
        linkId: `${sessionId}-link`,
        handle: claudeProviderHandle(`${sessionId}-provider`, null),
        origin: 'created',
        mintedAtFence: 1,
        observedAt: NOW
      }
    ]
  })

/** The chat's journal as its last host left it: a sent prompt and a turn in `turn`'s state. */
async function seedJournal(sessionId: string, turn: 'running' | 'completed' | null): Promise<void> {
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId,
      workspaceId: LOCATION.workspaceId,
      hostId: LOCATION.executionHostId,
      agent: 'claude',
      providerHandle: claudeProviderHandle(`${sessionId}-provider`, null)
    },
    database: openTestJournalHostDatabase(root),
    now: () => NOW
  })
  if (turn) {
    await journal.appendSubmission({
      clientMessageId: `${sessionId}-send`,
      payloadFingerprint: '0'.repeat(64),
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `ask ${sessionId}` }] },
      fence: 1
    })
    await journal.appendItem(
      { provider: 'claude', sessionId: `${sessionId}-provider`, uuid: 'turn' },
      { kind: 'turn', turnId: 'turn-1', state: turn, startedAt: NOW },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  await journal.close()
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-startup-listing-'))
  const chats = [CUT, DONE, LEGACY_WORKING, NEVER_SENT, UNWRITTEN]
  await seedTestAgentSessionRecordStore(root, { records: chats.map(record) })
  await seedJournal(CUT, 'running')
  await seedJournal(DONE, 'completed')
  await seedJournal(LEGACY_WORKING, 'running')
  await seedJournal(NEVER_SENT, null)
  openTestJournalHostDatabase(root)
    .db.prepare('UPDATE journal_sessions SET open_turn_id = NULL WHERE session_id = ?')
    .run(LEGACY_WORKING)
  const capsule = new AgentSessionRecoveryCapsule(root)
  await capsule.record([marker({ sessionId: LEGACY_WORKING, recordedAt: NOW })], NOW)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store: await openTestAgentSessionRecordStore(root),
    adapter: {
      open: async () => ({ reportedOptions: { model: '' } }),
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsCreate: () => true
    },
    journalDatabase: openTestJournalHostDatabase(root),
    recoveryCapsule: capsule,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-2',
    idleSweep: { maxResident: 2 },
    now: () => NOW + 60_000
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await host.flushAllStreamedEvents()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it('lists every restored chat as Interrupted or Done, on every status surface, opening none', async () => {
  const sunk: AgentSessionStatusSummary[] = []
  host.deps.statusSink = {
    publish: (summary) => sunk.push(summary),
    forget: () => {},
    readChildWork: () => []
  }
  const opened = vi.spyOn(AgentSessionJournal.prototype, 'open')

  await host.restoreReadableSessions([CUT, DONE, LEGACY_WORKING, NEVER_SENT, UNWRITTEN])

  expect(opened).not.toHaveBeenCalled()
  expect(host.listSessionTabs().map((tab) => tab.sessionId)).toEqual([
    CUT,
    DONE,
    LEGACY_WORKING,
    NEVER_SENT
  ])
  let snapshot: AgentSessionStatusSummary[] = []
  host.subscribeStatus({
    id: 'sidebar',
    emit: (event) => {
      if (event.type === 'snapshot' && event.sessions.length > 0) {
        snapshot = event.sessions
      }
    }
  })
  // Each row's state, verdict and saved name, as the sidebar and the agent-status store read them.
  const rows = (summaries: AgentSessionStatusSummary[]) =>
    summaries.map((row) => [row.sessionId, row.status, row.turnOutcome, row.conversationName])
  const expected = [
    [CUT, 'idle', 'interruption'],
    [DONE, 'idle', undefined],
    [LEGACY_WORKING, 'idle', 'interruption'],
    [NEVER_SENT, null, undefined]
  ].map((row) => [...row, `name of ${row[0]}`])
  expect(rows(snapshot)).toEqual(expected)
  expect(rows(sunk)).toEqual(expected)
  expect([CUT, DONE, LEGACY_WORKING, NEVER_SENT].some(host.hasSession)).toBe(false)
})

it('reads a chat when it is opened, and keeps only the resident cap of opened chats', async () => {
  await host.restoreReadableSessions([CUT, DONE, LEGACY_WORKING])

  for (const sessionId of [CUT, DONE, LEGACY_WORKING]) {
    await host.journalSnapshot(sessionId)
  }

  // The first opened is the least recently active: it closes, and keeps its journal's own row.
  await vi.waitFor(() => expect(host.hasSession(CUT)).toBe(false))
  expect([DONE, LEGACY_WORKING].every(host.hasSession)).toBe(true)
  expect(host.readStatusSummary(CUT)).toMatchObject({
    status: 'idle',
    turnOutcome: 'interruption',
    latestPrompt: `ask ${CUT}`
  })
})
