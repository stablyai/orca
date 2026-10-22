import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  createRootDispatch,
  reattachDispatchConsumer
} from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

// openloop-i0lrpa.3177.3011: an admitted worker's unpinned `check --terminal <handle>`
// preferred `getCurrentRunForCoordinator` (whatever Run happens to be bound to this pane)
// over the worker's own active Dispatch. A worker that is ALSO a sub-run coordinator (the
// buildSubDispatchSection preamble teaches exactly this) binds a brand-new Run to its own
// pane via `run-create`, after which its next unpinned self-check silently read that new
// Run's mailbox instead of the parent Dispatch it was admitted under. `--dispatch <id>`
// pins the check to that exact dispatch_contexts row and bypasses the Run lookup entirely.
const WORKER_PANE = 'tab_worker:11111111-1111-4111-8111-111111111111'
const WORKER_PROCESS = 'runtime_test:term_worker:1'

type CheckResult = {
  messages: { subject: string }[]
  runId?: string
}

describe('orchestration.check --dispatch pins an admitted worker to its own Dispatch', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => h.cleanup())

  function admitWorker(): { dispatchId: string; parentRunId: string } {
    ;({ db, ctx } = h.setup())
    const task = db.createTask({ spec: 'parent task' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', WORKER_PANE)
    reattachDispatchConsumer(db, {
      dispatchId: dispatch.id,
      paneKey: WORKER_PANE,
      processIncarnation: WORKER_PROCESS
    })
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'parent instructions',
      runId: dispatch.run_id
    })
    return { dispatchId: dispatch.id, parentRunId: dispatch.run_id }
  }

  /** Simulates the worker, now a sub-run coordinator, binding a brand-new Run to its own pane. */
  function bindUnrelatedSubRunToWorkerPane(): string {
    return db.createRun({
      objective: 'sub-run the worker created',
      coordinatorHandle: 'term_worker',
      coordinatorPaneKey: WORKER_PANE
    }).id
  }

  function check(params: Record<string, unknown> = {}) {
    return h.call(
      'orchestration.check',
      { terminal: 'term_worker', terminalPaneKey: WORKER_PANE, ...params },
      ctx
    ) as Promise<CheckResult>
  }

  it('reproduces the bug: an unpinned check follows the pane to an unrelated new Run', async () => {
    const { parentRunId } = admitWorker()
    const subRunId = bindUnrelatedSubRunToWorkerPane()

    const result = await check()

    expect(result.runId).toBe(subRunId)
    expect(result.runId).not.toBe(parentRunId)
  })

  it('--dispatch pins the check to the admitted Dispatch regardless of the pane-bound Run', async () => {
    const { dispatchId, parentRunId } = admitWorker()
    bindUnrelatedSubRunToWorkerPane()

    const result = await check({ dispatch: dispatchId })

    expect(result.messages.map((m) => m.subject)).toEqual(['parent instructions'])
    expect(result.runId).toBe(parentRunId)
  })

  it('fences a forged/unowned --dispatch before any read or mutation, no side effects', async () => {
    const { dispatchId } = admitWorker()
    const task2 = db.createTask({ spec: 'unrelated task' })
    const foreign = createRootDispatch(
      db,
      task2.id,
      'term_other',
      'tab_other:99999999-9999-4999-8999-999999999999'
    )
    reattachDispatchConsumer(db, {
      dispatchId: foreign.id,
      paneKey: 'tab_other:99999999-9999-4999-8999-999999999999',
      processIncarnation: 'runtime_test:term_other:1'
    })
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${foreign.id}`,
      subject: 'not yours',
      runId: foreign.run_id
    })

    await expect(check({ dispatch: foreign.id })).rejects.toMatchObject({ code: 'consumer_fenced' })
    // No side effects: the foreign dispatch's mail is untouched, the admitted worker's own
    // dispatch is also untouched.
    expect(db.getUnreadMessages(`dispatch:${foreign.id}`)).toHaveLength(1)
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })

  it('fences a stale/mismatched --dispatch with --run that disagrees with the row', async () => {
    const { dispatchId } = admitWorker()

    await expect(check({ dispatch: dispatchId, run: 'run_not_this_one' })).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
  })

  it('fences a --dispatch pointing at an already-settled (completed) dispatch', async () => {
    const { dispatchId } = admitWorker()
    db.completeDispatch(dispatchId)

    await expect(check({ dispatch: dispatchId })).rejects.toMatchObject({ code: 'consumer_fenced' })
  })

  it('fences a stale --dispatch whose recorded process incarnation no longer matches (post-restart)', async () => {
    const { dispatchId } = admitWorker()
    // Simulate the dispatch row recording an OLDER process incarnation than the one the
    // runtime now reports for this handle (the harness mocks getTerminalProcessIncarnation
    // as `runtime_test:term_worker:1`) -- e.g. the worker's process restarted without a
    // reattach. isDispatchProcessCurrent must then disagree, and isDispatchMessageSender's
    // fallback must not rescue it since a process_incarnation IS recorded (just stale).
    reattachDispatchConsumer(db, {
      dispatchId,
      paneKey: WORKER_PANE,
      processIncarnation: 'runtime_test:term_worker:0-stale'
    })

    await expect(check({ dispatch: dispatchId })).rejects.toMatchObject({ code: 'consumer_fenced' })
  })

  it('leaves unpinned --run routing (a sub-run coordinator reading its own sub-run) untouched', async () => {
    admitWorker()
    const subRunId = bindUnrelatedSubRunToWorkerPane()
    db.insertMessage({
      from: 'term_sub_worker',
      to: `run:${subRunId}`,
      subject: 'sub-worker report',
      runId: subRunId
    })

    const result = await check({ run: subRunId })

    expect(result.runId).toBe(subRunId)
    expect(result.messages.map((m) => m.subject)).toContain('sub-worker report')
  })
})
