import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import type { DispatchCreator } from '../dispatch-depth'

describe('OrchestrationDb Run state', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  const COORD_PANE = 'tab_coord:11111111-1111-4111-8111-111111111111'

  function createBoundRun(d: OrchestrationDb) {
    return d.createRun({
      objective: 'Mailbox test',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORD_PANE
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
    it('refuses a worker binding an ancestor Run, but not a coordinator with a self-dispatch', () => {
      const d = createDb()
      const parent = createBoundRun(d)
      const coordinator = { kind: 'terminal', handle: 'term_coord', paneKey: COORD_PANE } as const
      const dispatchIn = (runId: string, handle: string, creator: DispatchCreator) =>
        d.createDispatchContext({
          taskId: d.createTask({ spec: 'work', runId }).id,
          assigneeHandle: handle,
          creator,
          maxDepth: Number.MAX_SAFE_INTEGER
        })
      // A context-only self-dispatch is bookkeeping, so its coordinator keeps its Run.
      dispatchIn(parent.id, 'term_coord', coordinator)
      expect(
        d.bindRun({
          runId: parent.id,
          coordinatorHandle: 'term_coord',
          coordinatorPaneKey: COORD_PANE
        })
      ).toBeDefined()
      dispatchIn(parent.id, 'term_worker', coordinator)
      const sub = d.createRun({
        objective: 'sub',
        coordinatorHandle: 'term_worker',
        coordinatorPaneKey: null
      })
      dispatchIn(sub.id, 'term_grand', { kind: 'terminal', handle: 'term_worker' })

      expect(() =>
        d.bindRun({ runId: parent.id, coordinatorHandle: 'term_grand', coordinatorPaneKey: null })
      ).toThrow(expect.objectContaining({ code: 'worker_cannot_coordinate_own_run' }))
      let creatorHandle = 'term_grand'
      for (let depth = 0; depth < 33; depth++) {
        const handle = `term_deep_${depth}`
        dispatchIn(sub.id, handle, { kind: 'terminal', handle: creatorHandle })
        creatorHandle = handle
      }
      expect(() =>
        d.bindRun({ runId: parent.id, coordinatorHandle: creatorHandle, coordinatorPaneKey: null })
      ).toThrow(expect.objectContaining({ code: 'worker_cannot_coordinate_own_run' }))
      expect(d.getRun(parent.id)?.coordinator_handle).toBe('term_coord')
    })
  })
})
