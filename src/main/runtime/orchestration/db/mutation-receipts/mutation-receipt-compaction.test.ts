import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import { expandCompactedMutationReceipt } from './mutation-receipt-compaction'

const LONG_AGO = '2000-01-01 00:00:00'

describe('OrchestrationDb mutation receipt compaction', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function storeReceipt(requestId: string, method: string, receipt: unknown, updatedAt: string) {
    db!.db
      .prepare(
        `INSERT INTO mutation_receipts
           (caller_fingerprint, request_id, method, payload_hash, state, receipt, updated_at)
         VALUES ('caller', ?, ?, 'hash', 'completed', ?, ?)`
      )
      .run(requestId, method, JSON.stringify(receipt), updatedAt)
  }

  function storedReceipt(requestId: string): Record<string, unknown> {
    return JSON.parse(db!.getMutationReceipt('caller', requestId)?.receipt ?? 'null')
  }

  const loadMessage = (messageId: string) => {
    const message = db!.getMessageById(messageId)
    return message ? { id: message.id, body: message.body } : undefined
  }

  it('reduces old check and reply receipts to message ids and replays them from storage', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Compaction',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const mail = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: `run:${run.id}`,
      subject: 's',
      body: 'question body'
    })
    const reply = db.insertMessage({
      runId: run.id,
      from: `run:${run.id}`,
      to: 'worker',
      subject: 'Re: s',
      body: 'answer body'
    })
    storeReceipt(
      'check_old',
      'orchestration.check',
      {
        runId: run.id,
        deliveryId: 'delivery_1',
        messages: [{ id: mail.id, body: 'question body', follow_up: 'start' }]
      },
      LONG_AGO
    )
    storeReceipt(
      'reply_old',
      'orchestration.reply',
      {
        message: { id: reply.id, body: 'answer body' },
        question: { message_id: mail.id, answer_body: 'answer body' }
      },
      LONG_AGO
    )

    db.compactMutationReceipts(0, 10)

    expect(storedReceipt('check_old')).toEqual({
      runId: run.id,
      deliveryId: 'delivery_1',
      compactedMessages: [{ id: mail.id, follow_up: 'start' }]
    })
    expect(storedReceipt('reply_old')).toEqual({
      question: { message_id: mail.id },
      compactedMessage: { id: reply.id }
    })
    expect(
      expandCompactedMutationReceipt(storedReceipt('check_old'), 'check_old', loadMessage)
    ).toEqual({
      runId: run.id,
      deliveryId: 'delivery_1',
      messages: [{ id: mail.id, body: 'question body', follow_up: 'start' }]
    })
    expect(
      expandCompactedMutationReceipt(storedReceipt('reply_old'), 'reply_old', loadMessage)
    ).toEqual({
      message: { id: reply.id, body: 'answer body' },
      question: { message_id: mail.id, answer_body: 'answer body' }
    })
  })

  it('keeps receipts inside the replay window, other methods, and mail it cannot rebuild', () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Compaction',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const mail = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: `run:${run.id}`,
      subject: 's',
      body: 'stored'
    })
    const fresh = { messages: [{ id: mail.id, body: 'stored' }] }
    const edited = { messages: [{ id: mail.id, body: 'not what is stored' }] }
    const send = { message: { id: mail.id, body: 'stored' } }
    db.db
      .prepare(
        `INSERT INTO mutation_receipts
           (caller_fingerprint, request_id, method, payload_hash, state, receipt)
         VALUES ('caller', 'check_fresh', 'orchestration.check', 'hash', 'completed', ?)`
      )
      .run(JSON.stringify(fresh))
    storeReceipt('check_edited', 'orchestration.check', edited, LONG_AGO)
    storeReceipt('send_old', 'orchestration.send', send, LONG_AGO)

    db.compactMutationReceipts(0, 10)

    expect(storedReceipt('check_fresh')).toEqual(fresh)
    expect(storedReceipt('check_edited')).toEqual(edited)
    expect(storedReceipt('send_old')).toEqual(send)
  })

  it('refuses to replay a compacted receipt whose message is gone', () => {
    expect(() =>
      expandCompactedMutationReceipt(
        { compactedMessages: [{ id: 'msg_gone' }] },
        'request_1',
        () => undefined
      )
    ).toThrowError(expect.objectContaining({ code: 'operation_unknown' }))
  })
})
