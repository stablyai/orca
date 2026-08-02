import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_RUN_ID, OrchestrationDb } from './db'

describe('OrchestrationDb Run state', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function createBoundRun(d: OrchestrationDb) {
    return d.createRun({
      objective: 'Mailbox test',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
    })
  }

  describe('Run deliveries', () => {
    it('returns one bounded FIFO batch and replays it until acknowledgment', () => {
      const d = createDb()
      const run = createBoundRun(d)
      for (let index = 0; index < 55; index++) {
        d.insertMessage({
          from: 'worker',
          to: `run:${run.id}`,
          subject: `message ${index}`,
          runId: run.id
        })
      }

      const first = d.getOrCreateRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation
      })
      const replay = d.getOrCreateRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation
      })

      expect(first?.messages).toHaveLength(50)
      expect(first?.messages[0].subject).toBe('message 0')
      expect(first?.messages[49].subject).toBe('message 49')
      expect(replay?.delivery.id).toBe(first?.delivery.id)
      expect(replay?.replayed).toBe(true)

      d.acknowledgeRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation,
        deliveryId: first!.delivery.id
      })
      const next = d.getOrCreateRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation
      })
      expect(next?.messages.map((message) => message.subject)).toEqual([
        'message 50',
        'message 51',
        'message 52',
        'message 53',
        'message 54'
      ])
    })

    it('acknowledges the whole batch idempotently without consuming newer mail', () => {
      const d = createDb()
      const run = createBoundRun(d)
      d.insertMessage({ from: 'a', to: `run:${run.id}`, subject: 'first', runId: run.id })
      const delivery = d.getOrCreateRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation
      })!
      d.insertMessage({ from: 'b', to: `run:${run.id}`, subject: 'newer', runId: run.id })

      const firstAck = d.acknowledgeRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation,
        deliveryId: delivery.delivery.id
      })
      const duplicateAck = d.acknowledgeRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation,
        deliveryId: delivery.delivery.id
      })

      expect(firstAck.duplicate).toBe(false)
      expect(duplicateAck.duplicate).toBe(true)
      expect(
        d
          .getOrCreateRunDelivery({
            runId: run.id,
            consumerGeneration: run.consumer_generation
          })
          ?.messages.map((message) => message.subject)
      ).toEqual(['newer'])
    })

    it('uses type filters only as wake predicates and returns the full oldest batch', () => {
      const d = createDb()
      const run = createBoundRun(d)
      d.insertMessage({ from: 'a', to: `run:${run.id}`, subject: 'status', runId: run.id })
      expect(
        d.getOrCreateRunDelivery({
          runId: run.id,
          consumerGeneration: run.consumer_generation,
          wakeTypes: ['worker_done']
        })
      ).toBeUndefined()
      d.insertMessage({
        from: 'b',
        to: `run:${run.id}`,
        subject: 'done',
        type: 'worker_done',
        runId: run.id
      })

      const delivery = d.getOrCreateRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation,
        wakeTypes: ['worker_done']
      })
      expect(delivery?.messages.map((message) => message.subject)).toEqual(['status', 'done'])
    })

    it('fences an outstanding batch when the Run consumer changes', () => {
      const d = createDb()
      const run = createBoundRun(d)
      d.insertMessage({ from: 'a', to: `run:${run.id}`, subject: 'one', runId: run.id })
      const oldDelivery = d.getOrCreateRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation
      })!
      const rebound = d.bindRun({
        runId: run.id,
        coordinatorHandle: 'term_new',
        coordinatorPaneKey: 'tab_new:22222222-2222-4222-9222-222222222222'
      })!

      let fencedError: unknown
      try {
        d.acknowledgeRunDelivery({
          runId: run.id,
          consumerGeneration: run.consumer_generation,
          deliveryId: oldDelivery.delivery.id
        })
      } catch (error) {
        fencedError = error
      }
      expect(fencedError).toMatchObject({ code: 'consumer_fenced' })
      const replacement = d.getOrCreateRunDelivery({
        runId: run.id,
        consumerGeneration: rebound.consumer_generation
      })
      expect(replacement?.delivery.id).not.toBe(oldDelivery.delivery.id)
      expect(replacement?.messages.map((message) => message.subject)).toEqual(['one'])
    })

    it('replays an outstanding batch after reopening the database', () => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-delivery-'))
      const dbPath = join(dir, 'orchestration.db')
      try {
        const firstDb = new OrchestrationDb(dbPath)
        const run = createBoundRun(firstDb)
        firstDb.insertMessage({
          from: 'a',
          to: `run:${run.id}`,
          subject: 'survives',
          runId: run.id
        })
        const first = firstDb.getOrCreateRunDelivery({
          runId: run.id,
          consumerGeneration: run.consumer_generation
        })!
        firstDb.close()

        const reopened = new OrchestrationDb(dbPath)
        db = reopened
        const replay = reopened.getOrCreateRunDelivery({
          runId: run.id,
          consumerGeneration: run.consumer_generation
        })
        expect(replay?.delivery.id).toBe(first.delivery.id)
        expect(replay?.messages[0].subject).toBe('survives')
      } finally {
        db?.close()
        db = undefined
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('lightweight Run scope', () => {
    it('binds creation to one pane and fences that pane when it creates another Run', () => {
      const d = createDb()
      const first = d.createRun({
        objective: 'First objective',
        coordinatorHandle: 'term_first',
        coordinatorPaneKey: 'tab_a:11111111-1111-4111-8111-111111111111'
      })
      expect(first).toMatchObject({ consumer_generation: 1, legacy: 0 })
      expect(d.getCurrentRunForPane('tab_reminted:11111111-1111-4111-8111-111111111111')?.id).toBe(
        first.id
      )

      const second = d.createRun({
        objective: 'Second objective',
        coordinatorHandle: 'term_second',
        coordinatorPaneKey: 'tab_b:11111111-1111-4111-8111-111111111111'
      })
      expect(d.getRun(first.id)).toMatchObject({
        coordinator_handle: null,
        coordinator_pane_key: null,
        consumer_generation: 2
      })
      expect(d.getCurrentRunForPane('tab_b:11111111-1111-4111-8111-111111111111')?.id).toBe(
        second.id
      )
    })

    it('rebinds a Run by incrementing its consumer generation', () => {
      const d = createDb()
      const run = d.createRun({
        objective: 'Move coordinator',
        coordinatorHandle: 'term_old',
        coordinatorPaneKey: 'tab_old:11111111-1111-4111-8111-111111111111'
      })

      expect(
        d.bindRun({
          runId: run.id,
          coordinatorHandle: 'term_new',
          coordinatorPaneKey: 'tab_new:22222222-2222-4222-9222-222222222222'
        })
      ).toMatchObject({
        coordinator_handle: 'term_new',
        consumer_generation: 2
      })
      expect(d.getCurrentRunForPane('tab_old:11111111-1111-4111-8111-111111111111')).toBeUndefined()
      expect(
        d.bindRun({
          runId: LEGACY_RUN_ID,
          coordinatorHandle: 'term_new',
          coordinatorPaneKey: 'tab_new:22222222-2222-4222-9222-222222222222'
        })
      ).toBeUndefined()
    })

    it('associates task, dispatch, message, and gate rows with the selected Run', () => {
      const d = createDb()
      const run = d.createRun({
        objective: 'Scoped work',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab_coord:11111111-1111-4111-8111-111111111111'
      })
      const task = d.createTask({ spec: 'work', runId: run.id })
      const dispatch = d.createDispatchContext(task.id, 'term_worker')
      const message = d.insertMessage({
        runId: run.id,
        from: 'term_worker',
        to: 'term_coord',
        subject: 'status'
      })
      const gate = d.createGate({ taskId: task.id, question: 'Continue?' })

      expect(task.run_id).toBe(run.id)
      expect(dispatch.run_id).toBe(run.id)
      expect(message.run_id).toBe(run.id)
      expect(gate.run_id).toBe(run.id)
    })
  })
})
