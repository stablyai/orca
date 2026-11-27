import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { recordJournalConnectorReplies } from './journal-connector-replies'
import {
  readJournalConnectorReplies,
  readOwedJournalConnectorReplies
} from './journal-connector-replies-read'
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
  recordJournalConnectorReplies(db, { sessionId: 'chat-1', epoch: 'e' }, 'm1', false, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'fix it' }],
    connectorDelivery: {
      account: 'a',
      conversation: { source: 'slack', externalId: 'slack:T1:C1:1.2' },
      deliveryId: 'new'
    }
  })
  const rules = Object.fromEntries(
    readJournalConnectorReplies(db).map((row) => [row.deliveryId, row.quietRule ?? null])
  )
  db.close()
  expect(rules).toEqual({ old: null, new: 'trailing' })
})

it('uses the partial unsent index for full-table unsent outbox reads', () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-reply-schema-'))
  const db = new Database(join(dir, 'journal.db'))
  try {
    ensureJournalConnectorRepliesSchema(db)
    db.exec(`INSERT INTO journal_connector_replies
      (account,delivery_id,source,external_id,session_id,epoch,message_id,queued,sent_at)
      VALUES
        ('acct-1','sent-1','slack','slack:T1:C1:1.1','chat-1','e','m1',0,12345),
        ('acct-1','unsent-1','slack','slack:T1:C1:1.2','chat-1','e','m2',0,NULL)`)
    const allUnsentPlan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM journal_connector_replies WHERE sent_at IS NULL')
      .all()
      .map((row) => String(row.detail))
    expect(allUnsentPlan.some((d) => d.includes('journal_connector_replies_unsent'))).toBe(true)
    expect(readJournalConnectorReplies(db).map((row) => row.deliveryId)).toEqual(['unsent-1'])
    expect(readOwedJournalConnectorReplies(db, 'acct-1', null, 32)).toEqual([])
  } finally {
    db.close()
  }
})
