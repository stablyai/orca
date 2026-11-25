import { expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { replyEventsOf } from '../../../connector-cloud/connector-reply-outbox'
import { ensureJournalConnectorRepliesSchema } from './journal-connector-replies-schema'
import {
  fillJournalConnectorReplies,
  recordJournalConnectorReplies
} from './journal-connector-replies'
import { readJournalConnectorReplies } from './journal-connector-replies-read'

// An empty turn's tool-ran flag is the row's own: it survives the store and reaches its event alone.
it('keeps a no_answer row’s tools-ran flag through the store and onto its own event', () => {
  const db = new Database(':memory:')
  // A table an earlier build made, which lacks the column.
  db.exec(`CREATE TABLE journal_connector_replies (account TEXT NOT NULL, delivery_id TEXT NOT NULL,
    source TEXT NOT NULL, external_id TEXT NOT NULL, session_id TEXT NOT NULL, epoch TEXT NOT NULL,
    message_id TEXT NOT NULL, queued INTEGER NOT NULL, outcome TEXT, answer_delivery_id TEXT,
    turn_item_id TEXT, prose TEXT, failure_json TEXT, links_json TEXT, filled_at INTEGER,
    sent_at INTEGER, PRIMARY KEY(account, delivery_id)) WITHOUT ROWID`)
  ensureJournalConnectorRepliesSchema(db)
  const target = { sessionId: 'chat-1', epoch: 'e' }
  const conversation = { source: 'slack', externalId: 'slack:T1:C1:1.2' }
  for (const deliveryId of ['d1', 'd2']) {
    recordJournalConnectorReplies(
      db,
      target,
      deliveryId,
      false,
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'run it' }],
        connectorDelivery: { account: 'a', conversation, deliveryId }
      },
      1
    )
  }
  const fill = { account: 'a', outcome: 'no_answer' as const, answerDeliveryId: 'd1' }
  fillJournalConnectorReplies(
    db,
    [
      { ...fill, deliveryId: 'd1', toolsRan: true },
      { ...fill, deliveryId: 'd2' }
    ],
    1
  )
  const rows = readJournalConnectorReplies(db).flatMap((row) =>
    row.fill ? [{ ...row, fill: row.fill }] : []
  )
  expect(replyEventsOf(rows).map(({ deliveryIds, toolsRan }) => [deliveryIds, toolsRan])).toEqual([
    [['d1'], true],
    [['d1', 'd2'], undefined]
  ])
  db.close()
})
