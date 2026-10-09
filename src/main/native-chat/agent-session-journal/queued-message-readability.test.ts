import { afterEach, beforeEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { ensureQueuedMessagesTable } from './queued-message-schema'
import {
  getQueuedMessageHeader,
  hasReadableQueuedMessage,
  hasWaitingQueuedMessage,
  queuedMessageHeaders,
  unsettledQueuedMessageBodyBytes
} from './queued-message-headers'
import {
  getQueuedMessage,
  insertQueuedMessage,
  listQueuedMessages,
  queuedMessagesSettledByOp,
  withdrawQueuedMessageInTransaction
} from './queued-message-table'

let db: Database.Database
const SESSION = 'readability'
const body = { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'card' }] } as const

beforeEach(() => {
  db = new Database(':memory:')
  ensureQueuedMessagesTable(db)
  for (const messageId of ['a', 'b']) {
    insertQueuedMessage(db, {
      sessionId: SESSION,
      messageId,
      body: { ...body, blocks: [...body.blocks] },
      fingerprint: 'fp',
      hostInstance: 'host',
      queuedAt: { epoch: 'epoch', sequence: 1 },
      now: 1
    })
  }
})

afterEach(() => db.close())

it.each([
  { name: 'NUL suffix', stored: `${JSON.stringify(body)}\u0000garbage` },
  { name: 'BLOB JSON', stored: Buffer.from(JSON.stringify(body)) },
  { name: 'invalid JSON', stored: '{' }
])('excludes a $name body from headers and body reads', ({ stored }) => {
  db.prepare(
    "UPDATE queued_messages SET body_json = ?, settled_by_op = 'op' WHERE message_id = 'a'"
  ).run(stored)
  expect(getQueuedMessage(db, SESSION, 'a')).toBeNull()
  expect(getQueuedMessageHeader(db, SESSION, 'a')).toBeNull()
  expect(listQueuedMessages(db, SESSION).map((row) => row.messageId)).toEqual(['b'])
  expect(queuedMessagesSettledByOp(db, SESSION, 'op')).toEqual([])
  for (const selection of ['all', 'waiting', 'unsettled'] as const) {
    expect([...queuedMessageHeaders(db, SESSION, selection)].map((row) => row.messageId)).toEqual([
      'b'
    ])
  }
  expect(unsettledQueuedMessageBodyBytes(db, SESSION)).toBe(Buffer.byteLength(JSON.stringify(body)))
  expect(
    withdrawQueuedMessageInTransaction(db, {
      sessionId: SESSION,
      messageId: 'a',
      settledByOp: 'op',
      now: 2
    })
  ).toBe(0)
  db.prepare("DELETE FROM queued_messages WHERE message_id = 'b'").run()
  expect(hasWaitingQueuedMessage(db, SESSION)).toBe(false)
  expect(hasReadableQueuedMessage(db, SESSION)).toBe(false)
})

it('filters bodies beyond the SQLite nesting limit from the unsettled list', () => {
  db.prepare("UPDATE queued_messages SET body_json = ? WHERE message_id = 'a'").run(
    `${'['.repeat(1001)}0${']'.repeat(1001)}`
  )
  expect(listQueuedMessages(db, SESSION).map((row) => row.messageId)).toEqual(['b'])
})

it('reads valid bodies and receipts without a computed readability column', () => {
  db.prepare("UPDATE queued_messages SET settled_by_op = 'op' WHERE message_id = 'a'").run()
  expect(getQueuedMessage(db, SESSION, 'a')?.body).toEqual(body)
  expect(queuedMessagesSettledByOp(db, SESSION, 'op')).toEqual([
    expect.objectContaining({ messageId: 'a', body })
  ])
})

it('retains valid escaped NUL text in both header and body reads', () => {
  const text = 'contains\u0000a NUL'
  const valid = { ...body, blocks: [{ type: 'text', text }] }
  db.prepare("UPDATE queued_messages SET body_json = ? WHERE message_id = 'a'").run(
    JSON.stringify(valid)
  )
  expect(getQueuedMessage(db, SESSION, 'a')?.body).toEqual(valid)
  expect(getQueuedMessageHeader(db, SESSION, 'a')?.messageId).toBe('a')
})
