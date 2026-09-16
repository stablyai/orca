// Two independent version axes, both fail closed.
//
//   `PRAGMA user_version`  the DB SHAPE, known before the first read
//   the row's `v` field    the row BODY shape, met during replay
//
// A newer build can change either alone, so both are needed.

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { journalDatabaseFile } from './journal-paths'
import type { AgentSessionJournal } from './journal-store'
import { createTrackedJournalOpener } from './journal-store-test-open'

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
    journalDir: root,
    now: tick,
    mintEpoch: () => `epoch-${clock}`
  })
}

async function withDatabase(run: (db: Database.Database) => void): Promise<void> {
  const opened = openJournalDatabase(journalDatabaseFile(root))
  try {
    run(opened.db)
  } finally {
    opened.db.close()
  }
}

/** Appends a raw `row_json` the way a newer build or a bad write would leave it. */
async function appendRawRow(epoch: string, seq: number, rowJson: string): Promise<void> {
  await withDatabase((db) => {
    db.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    ).run(IDENTITY.sessionId, epoch, seq, 1, rowJson)
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
  it('latches read-only on a newer user_version and writes nothing', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    await journal.close()
    await withDatabase((db) => db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`))
    const before = await stat(journalDatabaseFile(root))

    const reopened = await open()
    expect(reopened.isReadOnly).toBe(true)
    await expect(reopened.appendItem(item(1), body('b'), { fence: 1 })).rejects.toMatchObject({
      code: 'journal_read_only'
    })
    // The file this build must not touch is byte-identical afterwards.
    await reopened.close()
    expect((await stat(journalDatabaseFile(root))).size).toBe(before.size)
    await withDatabase((db) => {
      expect(db.pragma('user_version', { simple: true })).toBe(JOURNAL_DB_SCHEMA_VERSION + 1)
    })
  })

  it('refuses the schema escape hatch on a latched store', async () => {
    const journal = await open()
    await journal.close()
    await withDatabase((db) => db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`))

    const reopened = await open()
    // With byte-copy quarantine gone there is nothing for `schema_unreadable` to
    // do differently, so it takes the same writable guard as every other reason.
    await expect(reopened.rollEpoch('schema_unreadable', 2)).rejects.toMatchObject({
      code: 'journal_read_only'
    })
    expect(reopened.isReadOnly).toBe(true)
  })

  it('migrates an older user_version forward on reopen', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    await journal.close()
    await withDatabase((db) => db.pragma('user_version = 0'))

    const reopened = await open()
    expect(reopened.isReadOnly).toBe(false)
    expect(reopened.snapshot().items).toHaveLength(1)
    await reopened.close()
    await withDatabase((db) => {
      expect(db.pragma('user_version', { simple: true })).toBe(JOURNAL_DB_SCHEMA_VERSION)
    })
  })
})

describe('axis 2: the row body shape', () => {
  it('degrades to read-only on a row from a newer build, without skipping it', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const epoch = journal.epoch
    const nextSeq = journal.cursor().sequence + 1
    await journal.close()
    await appendRawRow(
      epoch,
      nextSeq,
      JSON.stringify({
        v: 99,
        kind: 'item',
        epoch,
        seq: nextSeq,
        fence: 1,
        ts: 1,
        itemId: 'future',
        revision: 1,
        body: { kind: 'status', text: 'from a newer build' }
      })
    )

    const reopened = await open()
    expect(reopened.isReadOnly).toBe(true)
    await expect(reopened.appendItem(item(1), body('b'), { fence: 1 })).rejects.toMatchObject({
      code: 'journal_read_only'
    })
    await reopened.close()
    // Never skipped, never deleted: the row this build cannot read is still there.
    await withDatabase((db) => {
      const stored = db.prepare('SELECT row_json FROM journal_rows WHERE seq = ?').get(nextSeq) as {
        row_json: string
      }
      expect(stored.row_json).toContain('"v":99')
    })
  })

  it('skips a malformed row without giving up the journal, and discloses the skip', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const epoch = journal.epoch
    const nextSeq = journal.cursor().sequence + 1
    await journal.close()
    await appendRawRow(epoch, nextSeq, '{not json')

    const reopened = await open()
    expect(reopened.isReadOnly).toBe(false)
    const items = reopened.snapshot().items
    // The surviving row is untouched…
    expect(items.some((entry) => entry.body.kind === 'message')).toBe(true)
    // …and the skip is visible in the timeline instead of silently swallowed.
    expect(
      items.some(
        (entry) => entry.body.kind === 'status' && entry.body.text.includes('could not be read')
      )
    ).toBe(true)
  })

  it('keeps one disclosure row across reopens instead of stacking duplicates', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
    const epoch = journal.epoch
    const nextSeq = journal.cursor().sequence + 1
    await journal.close()
    await appendRawRow(epoch, nextSeq, '{not json')

    await open().then((first) => first.close())
    const reopened = await open()
    expect(
      reopened
        .snapshot()
        .items.filter(
          (entry) => entry.body.kind === 'status' && entry.body.text.includes('could not be read')
        )
    ).toHaveLength(1)
  })

  it('reopens a journal holding an admitted malformed-percent item id without throwing', async () => {
    const journal = await open()
    await journal.appendItem(item(0), body('a'), { fence: 1 })
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
    expect(reopened.isReadOnly).toBe(false)
    expect(reopened.snapshot().items.some((entry) => entry.itemId === '%')).toBe(true)
  })
})
