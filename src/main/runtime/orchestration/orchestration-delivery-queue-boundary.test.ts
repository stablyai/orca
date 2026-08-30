import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('queued-mail probe at the 50-id batch boundary', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => db?.close())

  function seed() {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'boundary',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
    return { d: db, run }
  }

  it('binds a FULL 50-member batch plus filters without exceeding SQLite variable limits', () => {
    const { d, run } = seed()
    // 60 rows straight into the run mailbox -> batch is the first 50.
    for (let i = 0; i < 60; i++) {
      d.insertMessage({ from: 'w', to: `run:${run.id}`, subject: `m${i}`, runId: run.id })
    }
    const first = d.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation,
      queuedTypes: ['status', 'worker_done', 'escalation', 'question', 'heartbeat']
    })!
    expect(first.messages).toHaveLength(50)
    // 50 ids + runId + address + 5 types = 57 bound params.
    expect(first.queuedMatchingMessages).toBe(true)
  })

  it('with a FULL batch, still sees an OLDER routed-in message that is not a member', () => {
    const { d, run } = seed()
    const parked = d.insertMessage({
      from: 'w',
      to: 'dispatch:disp_full',
      subject: 'parked worker_done',
      type: 'worker_done',
      runId: run.id
    })
    for (let i = 0; i < 50; i++) {
      d.insertMessage({ from: 'w', to: `run:${run.id}`, subject: `m${i}`, runId: run.id })
    }
    const first = d.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation
    })!
    expect(first.messages).toHaveLength(50)
    expect(first.messages.map((m) => m.id)).not.toContain(parked.id)

    d.routeUnreadDispatchMailboxToRunMailbox('disp_full', run.id)
    const replay = d.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation,
      queuedTypes: ['worker_done']
    })!
    expect(replay.replayed).toBe(true)
    expect(replay.queuedMatchingMessages).toBe(true)

    // ground truth: acking releases the older parked row first (lowest sequence)
    d.acknowledgeRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation,
      deliveryId: first.delivery.id
    })
    expect(
      d.getOrCreateRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation
      })!.messages[0].id
    ).toBe(parked.id)
  })

  it('does not report a batch member as queued behind itself', () => {
    const { d, run } = seed()
    d.insertMessage({ from: 'w', to: `run:${run.id}`, subject: 'only', runId: run.id })
    const first = d.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation
    })!
    expect(first.messages).toHaveLength(1)
    expect(first.queuedMatchingMessages).toBe(false)
    const replay = d.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation
    })!
    expect(replay.replayed).toBe(true)
    expect(replay.queuedMatchingMessages).toBe(false)
  })

  it('a type filter matching nothing queued still reports false', () => {
    const { d, run } = seed()
    d.insertMessage({ from: 'w', to: `run:${run.id}`, subject: 'head', runId: run.id })
    d.getOrCreateRunDelivery({ runId: run.id, consumerGeneration: run.consumer_generation })
    d.insertMessage({
      from: 'w',
      to: `run:${run.id}`,
      subject: 'beat',
      type: 'heartbeat',
      runId: run.id
    })
    const replay = d.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation,
      queuedTypes: ['worker_done']
    })!
    expect(replay.queuedMatchingMessages).toBe(false)
  })
})
