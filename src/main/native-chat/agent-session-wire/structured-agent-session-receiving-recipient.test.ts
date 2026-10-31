import { describe, expect, it } from 'vitest'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { dispatchReportMailbox } from '../../runtime/orchestration/dispatch-report-mailbox'
import {
  createReceivingCallerFixture,
  HELPER,
  HOME_A,
  HOME_B,
  PARENT,
  WORKER
} from './structured-agent-session-receiving-callers.test-support'

const NEXT = testOrcaSessionId('d2e4056e-2cf2-4e9f-958a-173f72acb592')

describe('receiving ownership uses current canonical mailbox and consumer', () => {
  it('hands actual unread helper mail from a stopped creator to its Run, then fences the old Run consumer', async () => {
    const f = await createReceivingCallerFixture()
    try {
      await f.found()
      await f.ensure(NEXT)
      await f.rig.store.setSessionTabVisibility(NEXT, true)
      const db = f.runtime.getOrchestrationDb()
      const run = db.createRun({
        objective: 'handback and takeover',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: PARENT
      })
      const worker = await f.createWorker(WORKER)
      const helper = await f.createWorker(HELPER, WORKER)
      f.selectB()
      expect(await f.rig.host.prospectiveAccountHome(WORKER)).toEqual(HOME_A)
      await f.report(helper)
      const message = db.getUndeliveredUnreadMessages(`dispatch:${worker.dispatch.id}`)[0]
      if (!message) {
        throw new Error('canonical report was not sent to its live creator')
      }
      expect(message.to_handle).toBe(dispatchReportMailbox(db, helper.dispatch))
      expect(f.runtime.mailTarget(message.to_handle)?.sessionId).toBe(WORKER)
      expect(
        await f.call('orchestration.workerStop', { dispatch: worker.dispatch.id })
      ).toMatchObject({ state: 'stopped' })
      expect(db.getMessageById(message.id)?.to_handle).toBe(`run:${run.id}`)
      expect(f.runtime.mailTarget(`run:${run.id}`)?.sessionId).toBe(PARENT)
      expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_A)
      const old = db.getOrCreateMailboxDelivery({
        runId: run.id,
        mailboxHandle: `run:${run.id}`,
        consumerGeneration: run.consumer_generation
      })
      if (!old) {
        throw new Error('old current consumer could not check real handback mail')
      }
      const rebound = db.bindRun({
        runId: run.id,
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: NEXT
      })
      if (!rebound) {
        throw new Error('supported Run takeover failed')
      }
      expect(rebound.consumer_generation).toBeGreaterThan(run.consumer_generation)
      expect(f.runtime.mailTarget(`run:${run.id}`)?.sessionId).toBe(NEXT)
      expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_B)
      expect(await f.rig.host.prospectiveAccountHome(NEXT)).toEqual(HOME_A)
      expect(() =>
        db.acknowledgeMailboxDelivery({
          runId: run.id,
          mailboxHandle: `run:${run.id}`,
          consumerGeneration: run.consumer_generation,
          deliveryId: old.delivery.id
        })
      ).toThrow()
      const current = db.getOrCreateMailboxDelivery({
        runId: run.id,
        mailboxHandle: `run:${run.id}`,
        consumerGeneration: rebound.consumer_generation
      })
      expect(current?.messages.map((row) => row.id)).toContain(message.id)
    } finally {
      await f.dispose()
    }
  })

  it.each(['settled', 'missing', 'wrong-run', 'null'] as const)(
    'accepts the actual report with a %s creator shape and old Task generation',
    async (shape) => {
      const f = await createReceivingCallerFixture()
      try {
        await f.found()
        const db = f.runtime.getOrchestrationDb()
        const run = db.createRun({
          objective: 'old canonical creator shapes',
          coordinatorHandle: null,
          coordinatorPaneKey: null,
          coordinatorOrcaSessionId: PARENT
        })
        const worker = await f.createWorker(WORKER)
        const helper = await f.createWorker(HELPER, WORKER)
        await f.call('orchestration.workerStop', { dispatch: worker.dispatch.id })
        if (shape !== 'settled') {
          let creator: string | null = null
          if (shape === 'missing') {
            creator = 'dispatch_old_missing'
          }
          if (shape === 'wrong-run') {
            const other = db.createRun({
              objective: 'different Run',
              coordinatorHandle: null,
              coordinatorPaneKey: null
            })
            creator = db.createStartingWorkerDispatch({
              taskSpec: 'other active creator',
              taskRunId: other.id,
              creator: { kind: 'system' },
              maxDepth: 9,
              startOptions: {}
            }).dispatch.id
          }
          // Persisted older/imported row shapes; report admission and Task lifetime remain production-owned.
          db.db
            .prepare('UPDATE dispatch_contexts SET creator_dispatch_id = ? WHERE id = ?')
            .run(creator, helper.dispatch.id)
        }
        db.db
          .prepare('UPDATE tasks SET created_by_run_generation = ? WHERE id = ?')
          .run(run.consumer_generation - 1, helper.task.id)
        const row = db.getDispatchContextById(helper.dispatch.id)
        if (!row) {
          throw new Error('real helper missing')
        }
        expect(dispatchReportMailbox(db, row)).toBe(`run:${run.id}`)
        f.selectB()
        expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_A)
        await f.report(helper)
        expect(db.getWorkerDispatch(helper.dispatch.id)?.state).toBe('succeeded')
        const message = db.getUndeliveredUnreadMessages(`run:${run.id}`)[0]
        expect(message?.to_handle).toBe(`run:${run.id}`)
        expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_A)
      } finally {
        await f.dispose()
      }
    }
  )
})
