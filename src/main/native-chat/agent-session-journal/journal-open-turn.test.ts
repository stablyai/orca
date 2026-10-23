// The chat's open root turn, saved beside its epoch pointer: what the next launch reads instead of
// the chat's history to say whether a turn was cut when its host stopped.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalTurnItem
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { journalPragmaNumber, openJournalDatabase } from './journal-database'
import {
  createAgentSessionRecordTablesSql,
  createJournalTablesSql,
  JOURNAL_DB_SCHEMA_VERSION
} from './journal-database-schema'
import { journalDatabasePath } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { journalRowBase } from './journal-row-builders'
import {
  insertJournalRow,
  readJournalRestFacts,
  readJournalSessionEpoch
} from './journal-row-table'
import { openAgentSessionJournal } from './journal-store-factory'

const SESSION = 'session-1'
const STARTED_AT = 1_800_000_000_000

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-open-turn-'))
})

afterEach(async () => {
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

const turnIdentity = (turnId: string): AgentJournalItemIdentity => ({
  provider: 'codex',
  threadId: 'thread-1',
  turnId,
  ordinal: 0
})

function turn(
  turnId: string,
  state: AgentJournalTurnItem['state'],
  outcome?: AgentJournalTurnItem['outcome']
): AgentJournalTurnItem {
  return { kind: 'turn', turnId, state, startedAt: STARTED_AT, ...(outcome ? { outcome } : {}) }
}

async function openJournal() {
  return openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    database: openTestJournalHostDatabase(root),
    now: () => STARTED_AT
  })
}

const openTurn = () => readJournalRestFacts(openTestJournalHostDatabase(root).db, SESSION)?.openTurn

it('brings a version 4 database forward, with every chat it held at rest', () => {
  const path = journalDatabasePath(root)
  const seeded = new Database(path)
  seeded.exec(createJournalTablesSql())
  seeded.exec(createAgentSessionRecordTablesSql())
  seeded
    .prepare('INSERT INTO journal_sessions (session_id, workspace_id, epoch) VALUES (?, ?, ?)')
    .run(SESSION, 'workspace-1', 'epoch-1')
  seeded.pragma('user_version = 4')
  seeded.close()

  const { db } = openJournalDatabase(path)
  try {
    expect(journalPragmaNumber(db, 'user_version')).toBe(JOURNAL_DB_SCHEMA_VERSION)
    expect(readJournalRestFacts(db, SESSION)).toEqual({
      openTurn: null,
      lastSequence: 0,
      lastSavedAt: 0
    })
  } finally {
    db.close()
  }
})

it('opens with the row that starts a turn, stays open through a cut, and closes on a finish', async () => {
  const journal = await openJournal()
  const write = (body: AgentJournalTurnItem) =>
    journal.appendItem(turnIdentity(body.turnId), body, {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  const cut = { itemId: agentJournalItemKey(turnIdentity('turn-1')), since: STARTED_AT }

  await write(turn('turn-1', 'running'))
  expect(openTurn()).toEqual(cut)
  // A quit, a crash or a Stop ends the turn without a finish: the next launch reads it cut.
  await write(turn('turn-1', 'interrupted'))
  expect(openTurn()).toEqual(cut)

  await write(turn('turn-2', 'running'))
  await write(turn('turn-2', 'completed', 'failure'))
  expect(openTurn()).toBeNull()
  await journal.close()
})

it('rolls the open turn back with the row whose transaction failed', async () => {
  const journal = await openJournal()
  await journal.close()
  const database = openTestJournalHostDatabase(root)
  const epoch = readJournalSessionEpoch(database.db, SESSION)!
  const body = turn('turn-1', 'running')

  expect(() =>
    database.transaction((db) => {
      insertJournalRow(db, SESSION, {
        kind: 'item',
        itemId: agentJournalItemKey(turnIdentity('turn-1')),
        revision: 1,
        body,
        ...journalRowBase(epoch, 2, 1, STARTED_AT, [body]),
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      expect(openTurn()).not.toBeNull()
      throw new Error('the rest of the write failed')
    })
  ).toThrow('the rest of the write failed')

  expect(openTurn()).toBeNull()
})
