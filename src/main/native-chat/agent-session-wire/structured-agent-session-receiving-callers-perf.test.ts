import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import {
  createReceivingCallerFixture,
  HOME_A,
  PARENT,
  WORKER
} from './structured-agent-session-receiving-callers.test-support'
import { observeReceivingSql } from './structured-agent-session-receiving-sql.test-support'

it.each([
  { n: 10, u: 100 },
  { n: 100, u: 100 },
  { n: 10, u: 1000 }
])(
  'bounds real receiving/report work with D/P=$n and independently varied U=$u',
  async ({ n, u }) => {
    const f = await createReceivingCallerFixture()
    try {
      await f.found()
      const db = f.runtime.getOrchestrationDb()
      const run = db.createRun({
        objective: 'relevant Run',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: PARENT
      })
      const workers: Awaited<ReturnType<typeof f.createWorker>>[] = []
      for (let i = 0; i < n; i += 1) {
        workers.push(await f.createWorker(testOrcaSessionId(randomUUID())))
      }
      const other = db.createRun({
        objective: 'unrelated',
        coordinatorHandle: null,
        coordinatorPaneKey: null
      })
      for (let i = 0; i < u; i += 1) {
        db.createStartingWorkerDispatch({
          taskSpec: 'unrelated work',
          taskRunId: other.id,
          creator: { kind: 'system' },
          maxDepth: 9,
          startOptions: {}
        })
      }
      // Reopen a real populated database with the old branch's index shape; keep cold cost separate.
      db.db.exec(
        'DROP INDEX idx_dispatch_creator_mailbox_work; DROP INDEX idx_runs_current_coordinator_handle; DROP INDEX idx_messages_native_direct_work'
      )
      const coldAt = performance.now()
      const reopened = new OrchestrationDb(join(f.rig.root, 'orchestration.db'))
      const coldMs = performance.now() - coldAt
      expect(
        reopened.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_dispatch_creator_mailbox_work'"
          )
          .get()
      ).toBeDefined()
      expect(reopened.db.prepare('SELECT count(*) AS n FROM dispatch_contexts').get()?.n).toBe(
        n + u
      )
      reopened.close()
      f.selectB()
      const active = observeReceivingSql(db)
      const activeAt = performance.now()
      expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_A)
      const activeMs = performance.now() - activeAt
      active.stop()
      expect(active.measurements.executions).toBeLessThanOrEqual(40 + 5 * n)
      expect(active.measurements.rows).toBeLessThanOrEqual(12 + 4 * n)
      let reportExecutions = 0
      let reportRows = 0
      let reportMs = 0
      for (const worker of workers) {
        const observed = observeReceivingSql(db)
        const at = performance.now()
        await f.report(worker)
        reportMs += performance.now() - at
        observed.stop()
        expect(db.getWorkerDispatch(worker.dispatch.id)?.state).toBe('succeeded')
        expect(observed.measurements.executions).toBeLessThanOrEqual(300 + 25 * n)
        expect(observed.measurements.rows).toBeLessThanOrEqual(200 + 20 * n)
        reportExecutions += observed.measurements.executions
        reportRows += observed.measurements.rows
      }
      expect(db.getUndeliveredUnreadMessages(`run:${run.id}`)).toHaveLength(n)
      const pending = observeReceivingSql(db)
      const pendingAt = performance.now()
      expect(await f.rig.host.prospectiveAccountHome(PARENT)).toEqual(HOME_A)
      const pendingMs = performance.now() - pendingAt
      pending.stop()
      expect(pending.measurements.executions).toBeLessThanOrEqual(40 + 5 * n)
      expect(pending.measurements.rows).toBeLessThanOrEqual(12 + 4 * n)
      const plans = [...active.measurements.plans, ...pending.measurements.plans]
      expect(plans.some((plan) => plan.includes('idx_dispatch_run_status'))).toBe(true)
      expect(
        plans.filter((plan) => /\bSCAN (?:runs|dispatch_contexts|messages|tasks)\b/.test(plan))
      ).toEqual([])
      process.stdout.write(
        `receiving-callers D=${n} P=${n} M=1 U=${u} coldIndexedRows=${n + u} coldOpenMs=${coldMs.toFixed(3)} active=${JSON.stringify(active.measurements)} activeMs=${activeMs.toFixed(3)} pending=${JSON.stringify(pending.measurements)} pendingMs=${pendingMs.toFixed(3)} reportExecutions=${reportExecutions} reportRows=${reportRows} reportMs=${reportMs.toFixed(3)}\n`
      )
    } finally {
      await f.dispose()
    }
  }
)

it.each([10, 100])(
  'bounds two current mailbox roles at %i real nested candidates per role',
  async (n) => {
    const f = await createReceivingCallerFixture()
    try {
      await f.found()
      const db = f.runtime.getOrchestrationDb()
      db.createRun({
        objective: 'original parent',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: PARENT
      })
      const worker = await f.createWorker(WORKER)
      for (let i = 0; i < n; i += 1) {
        await f.createWorker(testOrcaSessionId(randomUUID()), WORKER)
      }
      const own = db.createRun({
        objective: 'worker also coordinates',
        coordinatorHandle: worker.handle,
        coordinatorPaneKey: worker.paneKey,
        coordinatorOrcaSessionId: WORKER
      })
      for (let i = 0; i < n; i += 1) {
        await f.createWorker(testOrcaSessionId(randomUUID()), WORKER)
      }
      expect(f.runtime.mailTarget(`run:${own.id}`)?.sessionId).toBe(WORKER)
      expect(f.runtime.mailTarget(`dispatch:${worker.dispatch.id}`)?.sessionId).toBe(WORKER)
      f.selectB()
      const observed = observeReceivingSql(db)
      const began = performance.now()
      expect(await f.rig.host.prospectiveAccountHome(WORKER)).toEqual(HOME_A)
      const elapsedMs = performance.now() - began
      observed.stop()
      expect(observed.measurements.executions).toBeLessThanOrEqual(60 + 10 * n)
      expect(observed.measurements.rows).toBeLessThanOrEqual(30 + 8 * n)
      expect(
        observed.measurements.plans.some((plan) =>
          plan.includes('idx_dispatch_creator_mailbox_work')
        )
      ).toBe(true)
      expect(
        observed.measurements.plans.filter((plan) =>
          /\bSCAN (?:runs|dispatch_contexts|messages|tasks)\b/.test(plan)
        )
      ).toEqual([])
      process.stdout.write(
        `receiving-callers M=2 D=${n * 2} P=0 U=0 ${JSON.stringify(observed.measurements)} elapsedMs=${elapsedMs.toFixed(3)}\n`
      )
    } finally {
      await f.dispose()
    }
  }
)
