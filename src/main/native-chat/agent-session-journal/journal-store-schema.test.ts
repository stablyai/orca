import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
// Two independent version axes, both fail closed.
//
//   `PRAGMA user_version`  the DB SHAPE, known before the first read
//   the row's `v` field    the row BODY shape, met during replay
//
// A newer build can change either alone, so both are needed.

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { journalDatabasePath } from './journal-host-database'
import type { AgentSessionJournal } from './journal-store'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  liveTestJournalRows,
  insertTestJournalRowJson,
  SAVED_BY_NEWER_ORCA
} from './journal-host-database-test-support'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function tick(): number {
  clock += 1
  return clock
}

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function body(value: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: value }] }
}

function open(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: tick,
    mintEpoch: () => `epoch-${clock}`
  })
}

async function withDatabase(run: (db: Database.Database) => void): Promise<void> {
  const opened = openTestJournalHostDatabase(root)
  try {
    run(opened.db)
  } finally {
    opened.close()
  }
}

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

/** Appends a raw `row_json` the way a newer build or a bad write would leave it. */
async function appendRawRow(epoch: string, seq: number, rowJson: string): Promise<void> {
  await withDatabase((db) => {
    expect(liveTestJournalRows(db, IDENTITY.sessionId)[0]?.epoch).toBe(epoch)
    insertTestJournalRowJson(db, IDENTITY.sessionId, seq, rowJson)
  })
}

/** A row only a newer build could have written. */
function futureRow(epoch: string, seq: number): string {
  return JSON.stringify({
    v: 99,
    kind: 'item',
    epoch,
    seq,
    fence: 1,
    ts: 1,
    itemId: 'future',
    revision: 1,
    body: { kind: 'status', text: 'from a newer build' }
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-schema-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('axis 1: the database shape', () => {
  // A newer build's database: none of its chats open here, and nothing here writes to it.
  it('refuses every chat in a database a newer build stamped, and writes nothing', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.close()
    await withDatabase((db) => db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`))
    const before = await digest(journalDatabasePath(root))

    await expect(open()).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
    // A chat the database never held is refused the same way rather than being founded.
    await expect(
      journals.open({ identity: { ...IDENTITY, sessionId: 'session-2' }, stateDirectory: root })
    ).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
    await journals.closeAll()
    expect(await digest(journalDatabasePath(root))).toBe(before)
  })

  // Tables a newer schema changed read as a chat only an update opens, not as damage.
  it("refuses as a newer Orca's a chat whose tables a newer build changed", async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.close()
    await withDatabase((db) => {
      db.exec('ALTER TABLE journal_sessions RENAME TO journal_sessions_v4')
      db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
    })

    await expect(open()).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
  })

  // The only older version brought forward; 1 and 2 are refused (journal-database.test.ts).
  it('stamps the current user_version on a version-0 file that already has its tables', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.close()
    await withDatabase((db) => db.pragma('user_version = 0'))

    const reopened = await open()
    expect(reopened.snapshot().items).toHaveLength(1)
    await reopened.close()
    await withDatabase((db) => {
      expect(db.pragma('user_version', { simple: true })).toBe(JOURNAL_DB_SCHEMA_VERSION)
    })
  })
})

describe('axis 2: the row body shape', () => {
  it("refuses a journal holding a row from a newer build as a newer Orca's, and keeps that row", async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const epoch = journal.epoch
    const nextSeq = journal.cursor().sequence + 1
    await journal.close()
    await appendRawRow(epoch, nextSeq, futureRow(epoch, nextSeq))

    await expect(open()).rejects.toMatchObject(SAVED_BY_NEWER_ORCA)
    // Never skipped, never deleted: the row this build cannot read is still there.
    await withDatabase((db) => {
      const stored = liveTestJournalRows(db, IDENTITY.sessionId).find((row) => row.seq === nextSeq)
      expect(stored?.rowJson).toContain('"v":99')
    })
  })

  it('refuses a journal holding a row that is not a row, and keeps that row', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const epoch = journal.epoch
    const nextSeq = journal.cursor().sequence + 1
    await journal.close()
    await appendRawRow(epoch, nextSeq, '{not json')

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(open()).rejects.toMatchObject({
        refusal: { code: 'agent_session_journal_unreadable', details: { reason: 'journalCorrupt' } }
      })
    }
    await withDatabase((db) => {
      const stored = liveTestJournalRows(db, IDENTITY.sessionId)
      expect(stored.map((row) => row.seq)).toEqual([1, 2, nextSeq])
      expect(stored.at(-1)?.rowJson).toBe('{not json')
    })
  })

  it('reopens a journal holding an admitted malformed-percent item id without throwing', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const epoch = journal.epoch
    const nextSeq = journal.cursor().sequence + 1
    await journal.close()
    // `parseJournalRow` admits any string itemId, so replay must degrade a
    // malformed percent key to an opaque id instead of throwing URIError.
    await appendRawRow(
      epoch,
      nextSeq,
      JSON.stringify({
        v: 1,
        epoch,
        seq: nextSeq,
        fence: 1,
        ts: 1,
        kind: 'item',
        itemId: '%',
        revision: 1,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }
      })
    )

    const reopened = await open()
    expect(reopened.snapshot().items.some((entry) => entry.itemId === '%')).toBe(true)
  })
})
