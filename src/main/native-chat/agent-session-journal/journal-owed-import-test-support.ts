// A chat still in the per-chat file an earlier build left, opened the way startup restore opens
// one: its copy into the host's database is owed, and the chat's first write pays it before that
// write lands. It is the one backlog a chat's write queue really holds.

import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import Database from '../../sqlite/sync-database'
import {
  openTestJournalHostDatabase,
  readTestJournalRows
} from './journal-host-database-test-support'
import { journalDirectoryFor, legacyJournalDatabaseFile } from './journal-paths'
import type { JournalStoredRow } from './journal-row-table'
import type { AgentSessionJournal } from './journal-store'
import { openAgentSessionJournal } from './journal-store-factory'

const OWED_IMPORT_HISTORY_TEXT = 'history from the earlier build'

/** Opens `identity`'s chat from a per-chat file of real history rows, its copy still owed. */
export async function openJournalOwingImport(input: {
  stateDirectory: string
  identity: AgentSessionJournalIdentity
  now?: () => number
}): Promise<{ journal: AgentSessionJournal; history: JournalStoredRow[] }> {
  const { stateDirectory, identity } = input
  const history = await historyRows(input)
  await writePerChatFile(journalDirectoryFor(stateDirectory, identity), identity, history)
  const journal = await openAgentSessionJournal({
    identity,
    database: openTestJournalHostDatabase(stateDirectory),
    ...(input.now ? { now: input.now } : {}),
    deferPerSessionImport: true
  })
  if (!journal.importPending) {
    throw new Error('the chat opened with its copy already made')
  }
  return { journal, history }
}

/** Real rows, written by today's store into a scratch database, as an earlier build wrote them. */
async function historyRows(input: {
  stateDirectory: string
  identity: AgentSessionJournalIdentity
  now?: () => number
}): Promise<JournalStoredRow[]> {
  const scratch = join(input.stateDirectory, `scratch-${input.identity.sessionId}`)
  const journal = await openAgentSessionJournal({
    identity: input.identity,
    database: openTestJournalHostDatabase(scratch),
    ...(input.now ? { now: input.now } : {})
  })
  await journal.appendSubmission({
    clientMessageId: 'client-history',
    payloadFingerprint: 'fp-history',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'add a retry' }] },
    fence: 1,
    handoverRecorded: true
  })
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread-history', turnId: 'turn-history', ordinal: 1 },
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: OWED_IMPORT_HISTORY_TEXT }]
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.close()
  return readTestJournalRows(
    openTestJournalHostDatabase(scratch).db,
    input.identity.sessionId,
    journal.epoch
  )
}

/** The per-chat file an earlier build left, in its own schema. */
async function writePerChatFile(
  directory: string,
  identity: AgentSessionJournalIdentity,
  rows: readonly JournalStoredRow[]
): Promise<void> {
  const path = legacyJournalDatabaseFile(directory)
  await mkdir(dirname(path), { recursive: true })
  const db = new Database(path)
  try {
    db.pragma('journal_mode = WAL')
    db.exec(`
CREATE TABLE journal_rows (session_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
  ts INTEGER NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (session_id, epoch, seq));
CREATE TABLE journal_sessions (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE journal_repairs (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL,
  content_from INTEGER NOT NULL, repaired_at INTEGER NOT NULL);`)
    db.pragma('user_version = 2')
    const insert = db.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    )
    for (const row of rows) {
      insert.run(identity.sessionId, row.epoch, row.seq, row.ts, row.rowJson)
    }
    db.prepare('INSERT INTO journal_sessions VALUES (?, ?, ?)').run(
      identity.sessionId,
      rows[0]!.epoch,
      1
    )
  } finally {
    db.close()
  }
}
