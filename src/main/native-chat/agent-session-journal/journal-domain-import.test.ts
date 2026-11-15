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
import { insertJournalRow, publishJournalSessionEpoch } from './durable-rows/journal-row-table'
import { publishJournalOutcomeEpoch } from './outcomes/journal-outcome-epoch.test-fixture'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import { prepareJournalDomainImport } from './journal-domain-import'
import { applyJournalSqlMaintenance } from './journal-sql-maintenance'
import { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { JournalSqlConversions } from './journal-sql-conversions'
import { journalSqlReaderPath } from './journal-sql-worker-bundle.test-fixture'
import { readJournalDomainQueuePauseContext } from './journal-domain-queue-pauses'
import { readJournalDomainTurnScope } from './journal-domain-turn-scope'
import { readJournalDomainItems } from './journal-sql-item-reads'
import { readJournalSqlDatabase } from './journal-sql-database-read'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) {
    close()
  }
})

/** The new file has no source history; the original stays separate and read-only. */
function savedChat(retained = true) {
  const root = mkdtempSync(join(tmpdir(), 'orca-domain-import-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const filename = join(root, 'agent-session-domain.db')
  const originalFilename = join(root, 'original.db')
  const { db: source } = openJournalDatabase(originalFilename)
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
  runJournalTransaction(source, () => {
    publishJournalSessionEpoch(source, { sessionId: 'session', workspaceId: 'workspace' }, 'epoch')
    if (retained) {
      publishJournalOutcomeEpoch(source, 'session', 'epoch', rows)
    } else {
      rows.forEach((row) => insertJournalRow(source, 'session', row))
    }
  })
  source.close()
  const reader = new Database(originalFilename, { readonly: true, fileMustExist: true })
  cleanup.push(() => reader.close())
  return { db, reader, originalFilename }
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
    head: db
      .prepare(`SELECT session_id,epoch,last_sequence,retained_sequence,highest_fence,
      context_boundary,last_activity_at FROM journal_chat_state`)
      .all()
  }
}

it('imports settlement identity order and live lifecycle facts, discarding both on an unready restart', () => {
  const { db, reader, originalFilename } = savedChat(false)
  const { db: source } = openJournalDatabase(originalFilename)
  runJournalTransaction(source, () => {
    for (const [index, settlementId] of ['older', 'newer', 'older'].entries()) {
      insertJournalRow(source, 'session', {
        v: 4,
        epoch: 'epoch',
        seq: 25 + index,
        ts: 110 + index,
        fence: 1,
        kind: 'lifecycle-batch',
        settlementId,
        mutations:
          index === 1
            ? [{ kind: 'tombstone', itemId: 'removed', revision: 1 }]
            : [
                {
                  kind: 'item',
                  itemId: 'tool',
                  revision: index + 1,
                  body: {
                    kind: 'tool-call',
                    callId: 'tool',
                    name: 'read',
                    input: {},
                    state: index === 0 ? 'running' : 'completed'
                  }
                },
                {
                  kind: 'item',
                  itemId: 'legacy-window',
                  revision: 1,
                  body: {
                    kind: 'status',
                    text: 'Interrupted',
                    turnLifecycle: {
                      turnId: 'legacy-turn',
                      state: 'interrupted',
                      completedAt: 110.5,
                      contextUsage: { window: { tokens: 100, capturedAt: 109 } }
                    }
                  }
                },
                {
                  kind: 'item',
                  itemId: 'reasoning',
                  revision: 1,
                  body: {
                    kind: 'message',
                    role: 'assistant',
                    state: 'running',
                    blocks: [{ type: 'text', text: 'Working' }]
                  }
                },
                {
                  kind: 'item',
                  itemId: 'unverified-tool',
                  revision: 1,
                  body: {
                    kind: 'tool-call',
                    callId: 'unverified-tool',
                    name: 'read',
                    input: {},
                    state: 'failed',
                    endedAs: 'unverifiable'
                  }
                }
              ]
      })
    }
  })
  source.close()
  const imported = prepareJournalDomainImport(reader, 'session')!
  for (const page of imported.pages) {
    maintain(db, { kind: 'import-page', target: imported, page })
  }
  expect(
    db.prepare('SELECT settlement_id FROM journal_settlements ORDER BY settlement_id DESC').all()
  ).toEqual([{ settlement_id: 'older' }, { settlement_id: 'newer' }])
  expect(
    db
      .prepare("SELECT item_id,lifecycle_state,live_work FROM journal_items WHERE item_id='tool'")
      .get()
  ).toEqual({ item_id: 'tool', lifecycle_state: 'running', live_work: 0 })
  expect(
    db.prepare('SELECT item_id FROM journal_items WHERE hidden=0 AND context_window=1').all()
  ).toEqual([{ item_id: 'legacy-window' }])
  expect(
    db.prepare('SELECT item_id FROM journal_items WHERE hidden=0 AND unverified_end=1').all()
  ).toEqual([{ item_id: 'unverified-tool' }])
  expect(
    db
      .prepare(`SELECT item_id FROM journal_items WHERE hidden=0 AND root=1
        AND kind IN ('turn','status') AND lifecycle_state='interrupted' AND turn_completed_at=110.5`)
      .all()
  ).toEqual([{ item_id: 'legacy-window' }])
  expect(
    db.prepare("SELECT lifecycle_state FROM journal_items WHERE item_id='reasoning'").get()
  ).toEqual({ lifecycle_state: 'running' })
  maintain(db, { kind: 'import-discard', sessionId: 'session' })
  expect(db.prepare('SELECT settlement_id FROM journal_settlements').all()).toEqual([])
  expect(db.prepare('SELECT item_id FROM journal_items').all()).toEqual([])
  const resumed = prepareJournalDomainImport(reader, 'session')!
  for (const page of resumed.pages) {
    maintain(db, { kind: 'import-page', target: resumed, page })
  }
  maintain(db, { kind: 'import-finish', header: resumed })
  expect(
    db.prepare('SELECT settlement_id FROM journal_settlements ORDER BY settlement_id DESC').all()
  ).toEqual([{ settlement_id: 'older' }, { settlement_id: 'newer' }])
})

it('imports a frozen saved chat as typed domain rows, ready last, and resumes after interruption', () => {
  const { db, reader } = savedChat(false)
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
  expect(
    db
      .prepare(`SELECT message_id,attempt_sequence,admission_family_id,json_extract(facts_json,'$.admission.origin') AS admission_origin,
    json_extract(facts_json,'$.handover.sequence') AS handover_sequence,
    json_extract(facts_json,'$.handoverPlace.sequence') AS handover_place_sequence,
    json_extract(facts_json,'$.rejection.sequence') AS rejection_sequence,
    json_extract(facts_json,'$.rejection.keptMessageId') AS rejection_kept_message_id,
    echo_observed,admission_body_json IS NULL AS body_released
    FROM journal_submission_attempts ORDER BY message_id`)
      .all()
  ).toEqual([
    {
      message_id: 'first',
      attempt_sequence: 5,
      admission_family_id: 'command',
      admission_origin: 'client',
      handover_sequence: 6,
      handover_place_sequence: 6,
      rejection_sequence: null,
      rejection_kept_message_id: null,
      echo_observed: 0,
      body_released: 0
    },
    {
      message_id: 'retry',
      attempt_sequence: 10,
      admission_family_id: 'command',
      admission_origin: 'client',
      handover_sequence: 11,
      handover_place_sequence: 11,
      rejection_sequence: null,
      rejection_kept_message_id: null,
      echo_observed: 0,
      body_released: 0
    },
    {
      message_id: 'send',
      attempt_sequence: 18,
      admission_family_id: 'ordinary',
      admission_origin: 'host',
      handover_sequence: null,
      handover_place_sequence: null,
      rejection_sequence: null,
      rejection_kept_message_id: null,
      echo_observed: 1,
      body_released: 0
    }
  ])
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
  expect(
    readJournalDomainQueuePauseContext(db, { sessionId: 'session', epoch: 'epoch' }, null, []).marks
  ).toMatchObject({ resumedSequence: 17, reopenedSequence: 2 })
  expect(
    readJournalDomainTurnScope(
      db,
      { sessionId: 'session', epoch: 'epoch' },
      {
        kind: 'message',
        role: 'user',
        blocks: []
      }
    )
  ).toEqual({ kind: 'turn', turnItemId: 'failed' })
  expect(
    readJournalDomainItems(
      db,
      { sessionId: 'session', epoch: 'epoch' },
      {
        kind: 'named-turn',
        turnId: 'failed'
      }
    )
  ).toEqual({ kind: 'named-turn', turn: { scope: null, removed: true } })
})

it('keeps a ready chat on its domain rows and never reads the changed or missing frozen source', () => {
  const { db, reader, originalFilename } = savedChat()
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

  const source = new Database(originalFilename)
  source.exec(
    `DROP TABLE journal_rows; DROP TABLE journal_outcome_epochs; DROP TABLE queued_messages`
  )
  source.close()
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
    expect(db.prepare('SELECT workspace_id,epoch FROM journal_chat_state').get()).toEqual({
      workspace_id: 'workspace',
      epoch: null
    })
    expect(readJournalSqlDatabase(db, { kind: 'epoch', sessionId: 'session' })).toEqual({
      kind: 'epoch',
      epoch: null
    })
    expect(readJournalSqlDatabase(db, { kind: 'sessions', after: null })).toEqual({
      kind: 'sessions',
      sessionIds: ['session']
    })
    expect(
      readJournalSqlDatabase(db, { kind: 'retired-heads', after: null, through: null })
    ).toEqual({
      kind: 'retired-heads',
      heads: [],
      through: null
    })
    expect(db.prepare('SELECT item_id FROM journal_items').all()).toEqual([])
    await expect(conversions.ensure('session')).rejects.toThrow('interrupted before ready')
    expect(db.prepare('SELECT message_id FROM journal_send_receipts').all()).toEqual([
      { message_id: 'send' }
    ])
    // Discard preserves the catalog shell, including a workspace rekey since initialization.
    db.prepare('UPDATE journal_chat_state SET workspace_id=? WHERE session_id=?').run(
      'rekeyed-workspace',
      'session'
    )
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
    expect(db.prepare('SELECT workspace_id,epoch FROM journal_chat_state').get()).toEqual({
      workspace_id: 'rekeyed-workspace',
      epoch: 'current-original'
    })
    expect(db.prepare('SELECT epoch,item_id FROM journal_items').all()).toEqual([
      { epoch: 'current-original', item_id: 'failed' }
    ])
    expect(db.prepare('SELECT message_id FROM journal_send_receipts').all()).toEqual([])
    expect(db.prepare('SELECT message_id FROM journal_submission_attempts').all()).toEqual([])
    expect(db.prepare('SELECT session_id FROM journal_chat_state').all()).toEqual([
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
    db.prepare('UPDATE journal_chat_state SET epoch=? WHERE session_id=?').run(
      'rollover',
      'session'
    )
    expect(readJournalSqlDatabase(db, { kind: 'epoch', sessionId: 'session' })).toEqual({
      kind: 'epoch',
      epoch: 'rollover'
    })
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
