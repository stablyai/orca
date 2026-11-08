import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalDatabasePath } from './database/journal-host-database'
import { JournalSqlOwner } from './journal-sql-owner'
import { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { JournalSqlConversions } from './journal-sql-conversions'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { journalInputOrder } from './input-order/journal-input-order'
import { createFixture } from './queued-messages/journal-unsent-send-hold-contract-test-fixture'
import {
  closeTestJournalHostDatabase,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  updateTestJournalRowJson
} from './store-lifecycle/journal-host-database-test-support'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'

const fixture = createFixture()
const owners: JournalSqlOwner[] = []
const pools: JournalSqlReaderPool[] = []
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()))
  await Promise.all(owners.splice(0).map((owner) => owner.close()))
})

async function workers() {
  const filename = journalDatabasePath(fixture.root)
  const writer = new JournalSqlOwner(filename, fixture.root, journalSqlWorkerPath())
  owners.push(writer)
  await writer.opened()
  const readers = new JournalSqlReaderPool(filename, filename, journalSqlReaderPath())
  pools.push(readers)
  return { writer, readers }
}

async function convert() {
  await closeTestJournalHostDatabase(fixture.root)
  const { writer, readers } = await workers()
  const source = new Database(journalDatabasePath(fixture.root), { readonly: true })
  try {
    const saved = () => [
      source.prepare('SELECT * FROM journal_rows ORDER BY seq').all(),
      source.prepare('SELECT * FROM journal_outcomes ORDER BY generation,seq,field,entry_key').all()
    ]
    const before = saved()
    const converter = new JournalSqlConversions(writer, readers, async () => {})
    try {
      expect(await converter.ensure(fixture.IDENTITY.sessionId, false)).toBe('epoch-1')
    } finally {
      await converter.close()
    }
    expect(saved()).toEqual(before)
  } finally {
    source.close()
  }
  await readers.close()
  await writer.close()
}

async function openAndOrder() {
  const { writer, readers } = await workers()
  try {
    await writer.write({
      target: { sessionId: fixture.IDENTITY.sessionId, epoch: 'epoch-1', ownerToken: 'open' },
      operation: { kind: 'open' },
      facts: { identity: fixture.IDENTITY }
    })
    const db = new Database(journalDatabasePath(fixture.root), { readonly: true })
    try {
      const state = new JournalSqlReducer(
        new JournalSqlScope(db, fixture.IDENTITY.sessionId, 'epoch-1'),
        'epoch-1'
      ).state
      return journalInputOrder(state)
        .cards.list()
        .filter((card) => card.state === 'waiting')
        .map((card) => card.messageId)
    } finally {
      db.close()
    }
  } finally {
    await readers.close()
    await writer.close()
  }
}

it('keeps witnessed predecessors through background conversion, a failed open and later restarts', async () => {
  const journal = await fixture.open()
  await journal.queuedMessages.insert({
    messageId: 'C1',
    body: { ...fixture.message('/compact'), command: { name: 'compact' } }
  })
  await fixture.accept(journal, 'S', { origin: 'client' })
  await journal.queuedMessages.insert({ messageId: 'C2', body: fixture.message('C2') })
  await journal.queuedMessages.move({ messageId: 'C2', beforeMessageId: 'C1' })
  await journal.close()
  await convert()
  const db = new Database(journalDatabasePath(fixture.root))
  try {
    db.exec(`CREATE TRIGGER fail_recovery BEFORE INSERT ON journal_outcomes
      BEGIN SELECT RAISE(ABORT, 'interrupted open'); END`)
    await expect(openAndOrder()).rejects.toThrow()
    db.exec('DROP TRIGGER fail_recovery')
  } finally {
    db.close()
  }
  expect(await openAndOrder()).toEqual(['C2', 'C1', 'S'])
  expect(await openAndOrder()).toEqual(['C2', 'C1', 'S'])
})

it('distinguishes in-doubt imported handoffs from direct and linked proven-unwritten sends', async () => {
  const journal = await fixture.open()
  for (const id of ['H', 'S', 'Q']) {
    await fixture.accept(journal, id, { origin: 'client' })
  }
  await journal.close()
  const { db } = openTestJournalHostDatabase(fixture.root)
  for (const [send, card, position] of [
    ['H', 'legacy', 10],
    ['Q', 'linked', 20]
  ] as const) {
    const stored = liveTestJournalRows(db, fixture.IDENTITY.sessionId).find(
      (row) => JSON.parse(row.rowJson).clientMessageId === send
    )!
    const row = JSON.parse(stored.rowJson)
    row.queuedMessageId = card
    if (send === 'H') {
      delete row.handoverRecorded
    }
    updateTestJournalRowJson(db, fixture.IDENTITY.sessionId, stored.seq, JSON.stringify(row))
    const body = fixture.message(`text of ${send}`)
    db.prepare(`INSERT INTO queued_messages (session_id,message_id,position,body_json,fingerprint,
      created_at,host_instance,state,consumed_as) VALUES (?,?,?,?,?,?,?,'dispatched',?)`).run(
      fixture.IDENTITY.sessionId,
      card,
      position,
      JSON.stringify(body),
      fixture.fingerprint(body),
      100,
      'previous-host',
      send
    )
  }
  await convert()
  expect(await openAndOrder()).toEqual(['S', 'linked'])
  expect(await openAndOrder()).toEqual(['S', 'linked'])
})
