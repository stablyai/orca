import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { dropDerivedDeliverySchema } from './db/schema/derived-delivery-test-fixture'
import { resolveOrchestrationMigrationStartVersion } from './orchestration-schema-version-skew'

describe('unanswered-question mailbox fairness', () => {
  let db: OrchestrationDb
  let directory: string | undefined

  afterEach(() => {
    db?.close()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function createMailbox(path = ':memory:') {
    db = new OrchestrationDb(path)
    const run = db.createRun({
      objective: 'Mailbox fairness',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
    const task = db.createTask({ spec: 'ask', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    const questions = Array.from(
      { length: 55 },
      (_, index) =>
        db.createQuestion({
          runId: run.id,
          dispatchId: dispatch.id,
          askerHandle: 'term_worker',
          question: `Question ${index}`
        }).message.id
    )
    const consumer = { runId: run.id, consumerGeneration: run.consumer_generation }
    const send = (subject: string) =>
      db.insertMessage({ from: 'worker', to: `run:${run.id}`, subject, runId: run.id }).id
    const next = () => db.getOrCreateRunDelivery(consumer)!
    const acknowledge = (deliveryId: string) =>
      db.acknowledgeRunDelivery({ ...consumer, deliveryId })
    return { questions, consumer, send, next, acknowledge }
  }

  it('advances past a full question batch, replays outstanding mail, and repeats unanswered questions', () => {
    const { questions, send, next, acknowledge } = createMailbox()
    const status = send('later status')
    const first = next()
    expect(first.messages.map((message) => message.id)).toEqual(questions.slice(0, 50))
    expect(next()).toMatchObject({ delivery: { id: first.delivery.id }, replayed: true })
    acknowledge(first.delivery.id)
    const tail = next()
    expect(tail.messages.map((message) => message.id)).toEqual([...questions.slice(50), status])
    // Retrying an older acknowledgement must not rewind the outstanding batch.
    expect(acknowledge(first.delivery.id).duplicate).toBe(true)
    expect(next()).toMatchObject({ delivery: { id: tail.delivery.id }, replayed: true })
    acknowledge(tail.delivery.id)
    expect(db.getMessageById(status)?.read).toBe(1)
    expect(questions.every((id) => db.getMessageById(id)?.read === 0)).toBe(true)

    const repeated = next()
    expect(repeated.messages.map((message) => message.id)).toEqual(questions.slice(0, 50))
    acknowledge(repeated.delivery.id)
    expect(next().messages.map((message) => message.id)).toEqual(questions.slice(50))
  })

  it('finishes each question sweep despite new mail arriving before every acknowledgement', () => {
    const { questions, send, next, acknowledge } = createMailbox()
    const arrivals: string[] = []
    const seen = new Set<string>()
    const questionDeliveries = new Map(questions.map((id) => [id, 0]))
    for (let batch = 0; batch < 8; batch++) {
      const current = next()
      expect(current.messages.length).toBeLessThanOrEqual(50)
      for (const message of current.messages) {
        seen.add(message.id)
        if (questionDeliveries.has(message.id)) {
          questionDeliveries.set(message.id, questionDeliveries.get(message.id)! + 1)
        }
      }
      for (let index = 0; index < 50; index++) {
        arrivals.push(send(`arrival ${batch}:${index}`))
      }
      acknowledge(current.delivery.id)
    }
    expect([...questionDeliveries.values()].every((count) => count >= 2)).toBe(true)
    expect(arrivals.slice(0, 100).every((id) => seen.has(id))).toBe(true)
    expect(questions.every((id) => db.getMessageById(id)?.read === 0)).toBe(true)
    for (let batch = 0; batch < 10; batch++) {
      const current = next()
      for (const message of current.messages) {
        seen.add(message.id)
      }
      acknowledge(current.delivery.id)
    }
    expect(arrivals.every((id) => seen.has(id))).toBe(true)
  })

  it('persists acknowledged progress and the finite sweep boundary across reopening', () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-mailbox-fairness-'))
    const path = join(directory, 'orchestration.db')
    const { questions, send, next, acknowledge } = createMailbox(path)
    const status = send('included in first sweep')
    const first = next()
    acknowledge(first.delivery.id)
    const later = send('arrived after first sweep began')
    db.close()
    db = new OrchestrationDb(path)

    const tail = next()
    expect(tail.messages.map((message) => message.id)).toEqual([...questions.slice(50), status])
    db.close()
    db = new OrchestrationDb(path)
    expect(next()).toMatchObject({ delivery: { id: tail.delivery.id }, replayed: true })
    acknowledge(tail.delivery.id)
    const repeated = next()
    expect(repeated.messages.map((message) => message.id)).toEqual(questions.slice(0, 50))
    acknowledge(repeated.delivery.id)
    expect(next().messages.map((message) => message.id)).toEqual([...questions.slice(50), later])
  })

  it('starts a fresh sweep when the remaining questions are consumed between batches', () => {
    const { questions, consumer, send, next, acknowledge } = createMailbox()
    acknowledge(next().delivery.id)
    for (const messageId of questions.slice(50)) {
      db.answerQuestion({ ...consumer, messageId, body: 'Proceed' })
      db.markAsRead([messageId])
    }
    const later = send('arrived after questions were answered')
    const repeated = next()
    expect(repeated.messages.map((message) => message.id)).toEqual(questions.slice(0, 50))
    acknowledge(repeated.delivery.id)
    expect(next().messages.map((message) => message.id)).toEqual([later])
  })

  it('upgrades a v43 outstanding delivery without changing its replay or acknowledgement', () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-mailbox-upgrade-'))
    const path = join(directory, 'orchestration.db')
    const { questions, send, next, acknowledge } = createMailbox(path)
    const status = send('after old questions')
    const original = next()
    dropDerivedDeliverySchema(db.db)
    db.db.exec('ALTER TABLE deliveries DROP COLUMN sweep_end_sequence')
    db.db.exec('DROP INDEX idx_deliveries_acknowledged_mailbox')
    db.db.pragma('user_version = 43')
    expect(resolveOrchestrationMigrationStartVersion(db.db, 43, SCHEMA_VERSION)).toBe(43)
    db.close()
    db = new OrchestrationDb(path)
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(next()).toMatchObject({ delivery: { id: original.delivery.id }, replayed: true })
    acknowledge(original.delivery.id)
    // A pre-sweep delivery has no boundary, so the upgraded reader starts its first finite sweep.
    const upgraded = next()
    expect(upgraded.messages.map((message) => message.id)).toEqual(questions.slice(0, 50))
    acknowledge(upgraded.delivery.id)
    expect(next().messages.map((message) => message.id)).toEqual([...questions.slice(50), status])
    const plan = db.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT message_ids, sweep_end_sequence FROM deliveries
         WHERE run_id = ? AND mailbox_handle = ? AND consumer_generation = ?
           AND status = 'acknowledged' ORDER BY rowid DESC LIMIT 1`
      )
      .all(original.delivery.run_id, original.delivery.mailbox_handle, 1)
    expect(
      plan.some((row) => String(row.detail).includes('idx_deliveries_acknowledged_mailbox'))
    ).toBe(true)
    expect(plan.some((row) => String(row.detail).includes('TEMP B-TREE'))).toBe(false)
  })
})
