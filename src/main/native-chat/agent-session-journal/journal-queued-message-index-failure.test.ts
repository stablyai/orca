import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import Database from '../../sqlite/sync-database'
import { journalPragmaNumber, openJournalDatabase } from './journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { journalDatabasePath } from './journal-host-database'
import { hasWaitingQueuedMessage, queuedMessageHeaders } from './queued-message-headers'
import { getQueuedMessage, insertQueuedMessage, listQueuedMessages } from './queued-message-table'

const OPTIONAL_INDEXES = [
  'queued_messages_position',
  'queued_messages_readable_unsettled_position',
  'queued_messages_state_settled'
]
let root: string
let dbPath: string

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function insert(db: Database.Database, sessionId: string, messageId: string, text = messageId) {
  return insertQueuedMessage(db, {
    sessionId,
    messageId,
    body: message(text),
    fingerprint: `fp-${messageId}`,
    hostInstance: 'host',
    queuedAt: { epoch: 'epoch', sequence: 1 },
    now: 1
  })
}

function indexes(db: Database.Database) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'queued_messages'")
    .all()
    .map((row) => row.name)
}

function tables(db: Database.Database) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-queue-index-failure-'))
  dbPath = journalDatabasePath(root)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

it('opens a healthy chat when building indexes reaches another chat’s damaged overflow page', async () => {
  const seed = openJournalDatabase(dbPath).db
  let victim: number
  let pageSize: number
  try {
    seed.pragma('journal_mode = DELETE')
    for (const name of OPTIONAL_INDEXES) {
      seed.exec(`DROP INDEX ${name}`)
    }
    insert(seed, 'healthy', 'a1')
    insert(seed, 'damaged', 'b1', 'y'.repeat(20_000))
    const pages = seed
      .prepare(
        "SELECT pageno FROM dbstat WHERE name = 'queued_messages' AND pagetype = 'overflow' ORDER BY pageno"
      )
      .all()
    const page = pages[1]?.pageno
    if (typeof page !== 'number') {
      throw new Error('the large queued body must have a second overflow page')
    }
    victim = page
    pageSize = journalPragmaNumber(seed, 'page_size')
  } finally {
    seed.close()
  }
  const bytes = await readFile(dbPath)
  bytes.fill(0xff, (victim - 1) * pageSize, victim * pageSize)
  await writeFile(dbPath, bytes)

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  for (let attempt = 1; attempt <= 2; attempt++) {
    const opened = openJournalDatabase(dbPath)
    try {
      expect(opened.readOnly).toBe(false)
      expect(opened.db.isTransaction).toBe(false)
      expect(warn).toHaveBeenCalledTimes(attempt)
      expect(warn).toHaveBeenLastCalledWith('[journal-open] queued-message indexes skipped:', {
        reason: 'journalCorrupt',
        error: 'database disk image is malformed'
      })
      expect(indexes(opened.db)).toEqual(
        expect.arrayContaining(['queued_messages_consumed_as', 'queued_messages_position'])
      )
      expect(indexes(opened.db)).not.toContain('queued_messages_readable_unsettled_position')
      expect(indexes(opened.db)).not.toContain('queued_messages_state_settled')
      expect(hasWaitingQueuedMessage(opened.db, 'healthy')).toBe(true)
      expect([...queuedMessageHeaders(opened.db, 'healthy', 'waiting')]).toMatchObject([
        { messageId: 'a1', state: 'waiting' }
      ])
      expect(listQueuedMessages(opened.db, 'healthy')).toMatchObject([{ messageId: 'a1' }])
      expect(getQueuedMessage(opened.db, 'healthy', 'a1')?.body).toEqual(message('a1'))
    } finally {
      opened.db.close()
    }
  }
})

it('keeps required schema and queue reads after SQLITE_FULL, then retries indexes on the next open', () => {
  const failure = Object.assign(new Error('database or disk is full'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 13
  })
  const original = Database.prototype.exec
  const transactionAtBuild: boolean[] = []
  const tablesAtBuild: unknown[][] = []
  const exec = vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql.includes('CREATE INDEX IF NOT EXISTS queued_messages_position')) {
      transactionAtBuild.push(this.isTransaction)
      tablesAtBuild.push(tables(this))
      throw failure
    }
    return original.call(this, sql)
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const { db } = openJournalDatabase(dbPath)
  try {
    expect(transactionAtBuild).toEqual([false])
    expect(tablesAtBuild[0]).toEqual(
      expect.arrayContaining([
        'journal_rows',
        'agent_session_records',
        'agent_session_attachment_claims',
        'agent_session_attachment_sweeps',
        'queued_messages'
      ])
    )
    expect(journalPragmaNumber(db, 'user_version')).toBe(JOURNAL_DB_SCHEMA_VERSION)
    expect(indexes(db)).toContain('queued_messages_consumed_as')
    for (const name of OPTIONAL_INDEXES) {
      expect(indexes(db)).not.toContain(name)
    }
    insert(db, 'healthy', 'unreadable')
    db.prepare('UPDATE queued_messages SET body_json = ? WHERE message_id = ?').run(
      `${JSON.stringify(message('unreadable'))}\0suffix`,
      'unreadable'
    )
    insert(db, 'healthy', 'a1')
    expect(hasWaitingQueuedMessage(db, 'healthy')).toBe(true)
    expect([...queuedMessageHeaders(db, 'healthy', 'waiting')]).toMatchObject([{ messageId: 'a1' }])
    expect(listQueuedMessages(db, 'healthy')).toMatchObject([{ messageId: 'a1' }])
    expect(warn).toHaveBeenCalledExactlyOnceWith('[journal-open] queued-message indexes skipped:', {
      reason: 'journalUnavailable',
      error: failure.message
    })
  } finally {
    db.close()
    exec.mockRestore()
  }
  const reopened = openJournalDatabase(dbPath).db
  try {
    expect(indexes(reopened)).toEqual(expect.arrayContaining(OPTIONAL_INDEXES))
    expect(listQueuedMessages(reopened, 'healthy')).toMatchObject([{ messageId: 'a1' }])
    expect(warn).toHaveBeenCalledTimes(1)
  } finally {
    reopened.close()
  }
})

it('still refuses an open when the required unique consumed_as constraint cannot be created', () => {
  const failure = new Error('required unique index failed')
  const original = Database.prototype.exec
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS queued_messages_consumed_as')) {
      throw failure
    }
    return original.call(this, sql)
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  expect(() => openJournalDatabase(dbPath)).toThrow(failure)
  expect(warn).not.toHaveBeenCalled()
})
