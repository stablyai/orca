import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  initializeJournalDomainDatabase,
  openJournalDomainDatabase
} from './database/journal-domain-database'
import { openJournalDatabase, runJournalTransaction } from './database/journal-database'
import { publishJournalSessionEpoch } from './durable-rows/journal-row-table'
import { publishJournalOutcomeEpoch } from './outcomes/journal-outcome-write'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import { prepareJournalDomainImport } from './journal-domain-import'
import { applyJournalSqlMaintenance } from './journal-sql-maintenance'
import { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { JournalSqlConversions } from './journal-sql-conversions'
import { journalSqlReaderPath } from './journal-sql-worker-bundle.test-fixture'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) {
    close()
  }
})

/** A new file whose copied legacy tables hold one saved chat, as initialization publishes it. */
function copiedChat() {
  const root = mkdtempSync(join(tmpdir(), 'orca-domain-import-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const filename = join(root, 'agent-session-domain.db')
  const { db } = openJournalDomainDatabase(filename)
  cleanup.push(() => db.close())
  const rows = journalSqlRetryRows(true)
  rows.push({
    v: AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION,
    epoch: 'epoch',
    seq: rows.length + 1,
    ts: 100,
    fence: 1,
    kind: 'queue',
    messageId: 'steered',
    change: {
      op: 'queued',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'later' }] },
      position: 2,
      queuedAt: null,
      deliveryMode: 'steer',
      unattended: true
    }
  })
  runJournalTransaction(db, () => {
    publishJournalSessionEpoch(db, { sessionId: 'session', workspaceId: 'workspace' }, 'epoch')
    publishJournalOutcomeEpoch(db, 'session', 'epoch', rows)
  })
  const reader = new Database(filename, { readonly: true, fileMustExist: true })
  cleanup.push(() => reader.close())
  return { db, reader }
}

function maintain(
  db: Database.Database,
  operation: Parameters<typeof applyJournalSqlMaintenance>[1]
) {
  return runJournalTransaction(db, () => applyJournalSqlMaintenance(db, operation))
}

function domainRows(db: Database.Database) {
  return {
    items: db
      .prepare(`SELECT item_id, revision, sequence, sequence_index, hidden FROM journal_items
        WHERE session_id='session' ORDER BY sequence, sequence_index, ordinal`)
      .all(),
    tombstones: db
      .prepare(`SELECT item_id, revision FROM journal_item_tombstones ORDER BY item_id`)
      .all(),
    aliases: db
      .prepare(`SELECT provider_item_id, item_id, echo_declared FROM journal_item_aliases`)
      .all(),
    attempts: db
      .prepare(`SELECT message_id, dispatch_state, admitted_personal, candidate
        FROM journal_submission_attempts ORDER BY message_id`)
      .all(),
    receipts: db.prepare(`SELECT message_id FROM journal_send_receipts`).all(),
    cards: db
      .prepare(`SELECT message_id, state, position, json_extract(payload_json,'$.deliveryMode') AS mode,
        json_extract(payload_json,'$.unattended') AS unattended FROM journal_queue_cards
        ORDER BY message_id`)
      .all(),
    head: db.prepare(`SELECT * FROM journal_chat_state`).all()
  }
}

it('imports a frozen saved chat as typed domain rows, ready last, and resumes after interruption', () => {
  const { db, reader } = copiedChat()
  reader.exec('BEGIN')
  expect(() => prepareJournalDomainImport(reader, 'session')).toThrow(/outside a transaction/)
  reader.exec('ROLLBACK')

  expect(maintain(db, { kind: 'projection-state', sessionId: 'session' })).toEqual({
    state: 'converting',
    epoch: null
  })
  const interrupted = prepareJournalDomainImport(reader, 'session')!
  expect(reader.isTransaction).toBe(false)
  const { pages: first, ...target } = interrupted
  maintain(db, { kind: 'import-page', target, page: first.next().value! })
  // An interrupted import is not ready: commands see no chat head and its source stays authoritative.
  expect(maintain(db, { kind: 'projection-state', sessionId: 'session' })).toEqual({
    state: 'converting',
    epoch: null
  })

  const { pages, ...header } = prepareJournalDomainImport(reader, 'session')!
  for (const page of pages) {
    expect(maintain(db, { kind: 'import-page', target: header, page })).toBe(true)
  }
  expect(maintain(db, { kind: 'import-finish', header })).toBe('epoch')
  const item = (item_id: string, revision: number, sequence: number) => ({
    item_id,
    revision,
    sequence,
    sequence_index: 0,
    hidden: 0
  })
  const attempt = (message_id: string, dispatch_state: string) => ({
    message_id,
    dispatch_state,
    admitted_personal: 1,
    candidate: 0
  })
  const card = (message_id: string, state: string, position: number) => ({
    message_id,
    state,
    position,
    mode: null,
    unattended: null
  })
  expect(domainRows(db)).toEqual({
    items: [
      item('orca:command-turn%3Acompact', 2, 7),
      item('orca:first', 0, 8),
      item('orca:retry', 0, 13),
      item('orca:send', 1, 18)
    ],
    tombstones: [{ item_id: 'failed', revision: 2 }],
    aliases: [{ provider_item_id: 'codex:thread:echo:0', item_id: 'orca:send', echo_declared: 0 }],
    attempts: [
      attempt('first', 'rejected'),
      attempt('retry', 'rejected'),
      attempt('send', 'accepted')
    ],
    receipts: [{ message_id: 'send' }],
    cards: [
      card('command', 'returned', 1),
      card('foreign', 'withdrawn', -1),
      card('ordinary', 'dispatched', 1),
      { message_id: 'steered', state: 'waiting', position: 2, mode: 'steer', unattended: 1 }
    ],
    head: [
      {
        session_id: 'session',
        epoch: 'epoch',
        last_sequence: 24,
        retained_sequence: 24,
        highest_fence: 1,
        context_boundary: 1,
        last_activity_at: 100
      }
    ]
  })
})

it('keeps a ready chat on its domain rows and never reads the changed or missing frozen source', () => {
  const { db, reader } = copiedChat()
  const { pages, ...header } = prepareJournalDomainImport(reader, 'session')!
  const saved = [...pages]
  for (const page of saved) {
    maintain(db, { kind: 'import-page', target: header, page })
  }
  maintain(db, { kind: 'import-finish', header })
  const imported = domainRows(db)
  db.prepare(`UPDATE journal_items SET payload_json=json_set(payload_json,'$.observedAt',7)
    WHERE session_id='session'`).run()
  const current = db.prepare(`SELECT payload_json FROM journal_items ORDER BY item_id`).all()

  db.exec(`DROP TABLE journal_rows; DROP TABLE journal_outcome_epochs; DROP TABLE queued_messages`)
  expect(maintain(db, { kind: 'projection-state', sessionId: 'session' })).toEqual({
    state: 'ready',
    epoch: 'epoch'
  })
  for (const page of saved) {
    expect(maintain(db, { kind: 'import-page', target: header, page })).toBe(false)
  }
  expect(maintain(db, { kind: 'import-finish', header })).toBe('epoch')
  expect(domainRows(db)).toEqual(imported)
  expect(db.prepare(`SELECT payload_json FROM journal_items ORDER BY item_id`).all()).toEqual(
    current
  )
})

it('imports history from the separate original after interruption, taking the current original before ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-original-import-'))
  const originalFilename = join(root, 'agent-session-journal.db')
  const { db: original } = openJournalDatabase(originalFilename)
  let originalClosed = false
  const saved = journalSqlRetryRows(true)
  runJournalTransaction(original, () => {
    publishJournalSessionEpoch(
      original,
      { sessionId: 'session', workspaceId: 'workspace' },
      'epoch'
    )
    publishJournalOutcomeEpoch(original, 'session', 'epoch', saved)
  })
  const filename = await initializeJournalDomainDatabase(root)
  const { db } = openJournalDomainDatabase(filename)
  const pool = new JournalSqlReaderPool(filename, originalFilename, journalSqlReaderPath())
  let interrupt = true
  const conversions = new JournalSqlConversions(
    {
      maintain: async (operation) => {
        if (operation.kind === 'import-page' && operation.page.kind === 'cards' && interrupt) {
          interrupt = false
          throw new Error('interrupted before ready')
        }
        return maintain(db, operation)
      }
    },
    pool,
    async () => {}
  )
  try {
    expect(db.prepare('SELECT item_id FROM journal_items').all()).toEqual([])
    await expect(conversions.ensure('session')).rejects.toThrow('interrupted before ready')
    expect(db.prepare('SELECT message_id FROM journal_send_receipts').all()).toEqual([
      { message_id: 'send' }
    ])
    // A previous build may replace the original between failed new-build runs.
    const current = saved
      .filter((row) => row.kind === 'epoch' || (row.kind === 'item' && row.itemId === 'failed'))
      .map((row, index) => ({ ...row, epoch: 'current-original', seq: index + 1 }))
    runJournalTransaction(original, () => {
      publishJournalSessionEpoch(
        original,
        { sessionId: 'session', workspaceId: 'workspace' },
        'current-original'
      )
      publishJournalOutcomeEpoch(original, 'session', 'current-original', current)
    })
    expect(await conversions.ensure('session')).toBe('current-original')
    expect(db.prepare('SELECT epoch,item_id FROM journal_items').all()).toEqual([
      { epoch: 'current-original', item_id: 'failed' }
    ])
    expect(db.prepare('SELECT message_id FROM journal_send_receipts').all()).toEqual([])
    expect(db.prepare('SELECT message_id FROM journal_submission_attempts').all()).toEqual([])
    expect(db.prepare('SELECT session_id FROM journal_sessions').all()).toEqual([
      { session_id: 'session' }
    ])
    original.close()
    originalClosed = true
    rmSync(originalFilename)
    expect(await conversions.ensure('session')).toBe('current-original')
    expect(maintain(db, { kind: 'import-discard', sessionId: 'session' })).toEqual({
      more: false,
      epoch: 'current-original'
    })
    expect(db.prepare('SELECT item_id FROM journal_items').all()).toEqual([{ item_id: 'failed' }])
  } finally {
    await conversions.close()
    await pool.close()
    db.close()
    if (!originalClosed) {
      original.close()
    }
    rmSync(root, { recursive: true, force: true })
  }
})
