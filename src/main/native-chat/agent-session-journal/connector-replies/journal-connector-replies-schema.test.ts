import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import {
  fillEachJournalConnectorReply,
  fillJournalConnectorReplies,
  probeJournalConnectorReplyExpiry,
  recordJournalConnectorReplies
} from './journal-connector-replies'
import { readJournalConnectorReplies } from './journal-connector-replies-read'
import { ensureJournalConnectorRepliesSchema } from './journal-connector-replies-schema'

let dir = ''
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('reads a row an older build left as the older quiet rule, and records new rows as trailing', () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-reply-schema-'))
  const db = new Database(join(dir, 'journal.db'))
  // The table as a build before quiet_rule made it, with a pending row of its own.
  db.exec(`CREATE TABLE journal_connector_replies (account TEXT NOT NULL, delivery_id TEXT NOT NULL,
    source TEXT NOT NULL, external_id TEXT NOT NULL, session_id TEXT NOT NULL, epoch TEXT NOT NULL,
    message_id TEXT NOT NULL, queued INTEGER NOT NULL, outcome TEXT, answer_delivery_id TEXT,
    turn_item_id TEXT, prose TEXT, failure_json TEXT, links_json TEXT, filled_at INTEGER,
    sent_at INTEGER, PRIMARY KEY(account, delivery_id)) WITHOUT ROWID`)
  db.exec(`INSERT INTO journal_connector_replies
    (account,delivery_id,source,external_id,session_id,epoch,message_id,queued)
    VALUES('a','old','slack','slack:T1:C1:1.2','chat-1','e','m0',0)`)
  ensureJournalConnectorRepliesSchema(db)
  recordJournalConnectorReplies(
    db,
    { sessionId: 'chat-1', epoch: 'e' },
    'm1',
    false,
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'fix it' }],
      connectorDelivery: {
        account: 'a',
        conversation: { source: 'slack', externalId: 'slack:T1:C1:1.2' },
        deliveryId: 'new'
      }
    },
    1
  )
  const rules = Object.fromEntries(
    readJournalConnectorReplies(db).map((row) => [row.deliveryId, row.quietRule ?? null])
  )
  db.close()
  expect(rules).toEqual({ old: null, new: 'trailing' })
})

it('dates each new row, keeps why a fill closed quietly, and adds both to a table an older build made', () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-reply-schema-'))
  const db = new Database(join(dir, 'journal.db'))
  // The table as a build before admitted_at made it, with a pending row of its own.
  db.exec(`CREATE TABLE journal_connector_replies (account TEXT NOT NULL, delivery_id TEXT NOT NULL,
    source TEXT NOT NULL, external_id TEXT NOT NULL, session_id TEXT NOT NULL, epoch TEXT NOT NULL,
    message_id TEXT NOT NULL, queued INTEGER NOT NULL, outcome TEXT, answer_delivery_id TEXT,
    turn_item_id TEXT, prose TEXT, failure_json TEXT, links_json TEXT, filled_at INTEGER,
    sent_at INTEGER, PRIMARY KEY(account, delivery_id)) WITHOUT ROWID`)
  db.exec(`INSERT INTO journal_connector_replies
    (account,delivery_id,source,external_id,session_id,epoch,message_id,queued)
    VALUES('a','old','slack','slack:T1:C1:1.2','chat-1','e','m0',0)`)
  ensureJournalConnectorRepliesSchema(db)
  ensureJournalConnectorRepliesSchema(db)
  recordJournalConnectorReplies(
    db,
    { sessionId: 'chat-1', epoch: 'e' },
    'm1',
    false,
    {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'fix it' }],
      connectorDelivery: {
        account: 'a',
        conversation: { source: 'slack', externalId: 'slack:T1:C1:1.2' },
        deliveryId: 'new'
      }
    },
    1_800_000_000_000
  )
  fillJournalConnectorReplies(
    db,
    [
      {
        account: 'a',
        deliveryId: 'old',
        outcome: 'quiet',
        answerDeliveryId: 'old',
        expiredReason: 'old_request: answered for a request admitted at 2027-01-14T08:00:00.000Z'
      }
    ],
    1_800_000_000_001
  )
  const rows = Object.fromEntries(
    readJournalConnectorReplies(db).map((row) => [
      row.deliveryId,
      { admittedAt: row.admittedAt ?? null, expiredReason: row.fill?.expiredReason ?? null }
    ])
  )
  db.close()
  expect(rows).toEqual({
    old: {
      admittedAt: null,
      expiredReason: 'old_request: answered for a request admitted at 2027-01-14T08:00:00.000Z'
    },
    new: { admittedAt: 1_800_000_000_000, expiredReason: null }
  })
})

it('fills a batch reporting each row’s own result, and probes reasons by key alone', () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-reply-schema-'))
  const db = new Database(join(dir, 'journal.db'))
  ensureJournalConnectorRepliesSchema(db)
  for (const deliveryId of ['a', 'b']) {
    recordJournalConnectorReplies(
      db,
      { sessionId: 'chat-1', epoch: 'e' },
      deliveryId,
      false,
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'fix it' }],
        connectorDelivery: {
          account: 'acct',
          conversation: { source: 'slack', externalId: 'slack:T1:C1:1.2' },
          deliveryId
        }
      },
      1
    )
  }
  // Another writer settled a first: the batch's own fill of it changes nothing.
  fillJournalConnectorReplies(
    db,
    [{ account: 'acct', deliveryId: 'a', outcome: 'cancelled', answerDeliveryId: 'a' }],
    2
  )
  const quiet = (deliveryId: string) => ({
    account: 'acct',
    deliveryId,
    outcome: 'quiet' as const,
    answerDeliveryId: deliveryId,
    expiredReason: `old_request (${deliveryId})`
  })
  const changed = fillEachJournalConnectorReply(db, [quiet('a'), quiet('b')], 3)
  const reasons = probeJournalConnectorReplyExpiry(db, [
    { account: 'acct', deliveryId: 'a' },
    { account: 'acct', deliveryId: 'b' },
    { account: 'acct', deliveryId: 'gone' }
  ])
  db.close()
  expect([changed, reasons]).toEqual([
    [false, true],
    [null, 'old_request (b)', null]
  ])
})
