import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const PANE_OLD = 'tab_old:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PANE_NEW = 'tab_new:dddddddd-dddd-4ddd-8ddd-dddddddddddd'

type CheckResult = { messages: { subject: string }[]; count: number }

/**
 * worker-abandon + worker-start --retry-of moves the Task to another terminal, but the old worker
 * keeps polling. Its check used to fall through to the direct mailbox and answer `count: 0`, which
 * the worker contract reads as "checkpoint, not a failure" — so it kept editing the new owner's files.
 */
describe('orchestration.check from a terminal whose Attempt was superseded', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  afterEach(() => {
    h.cleanup()
  })

  function check(handle: string, paneKey: string, params: Record<string, unknown> = {}) {
    return h.call(
      'orchestration.check',
      { terminal: handle, terminalPaneKey: paneKey, ...params },
      ctx
    ) as Promise<CheckResult>
  }

  function startWorker(taskId: string, handle: string, paneKey: string, retryOf?: string): string {
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId,
      retryOf,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle,
      paneKey,
      processIncarnation: `runtime:${handle}:1`,
      worktreeId: 'repo::local',
      setupState: 'not_applicable',
      effects: []
    })
    return started.dispatch.id
  }

  function retriedOntoAnotherTerminal(): string {
    ;({ db, ctx } = h.setup())
    const task = db.createTask({ spec: 'work that moves terminals' })
    const abandoned = startWorker(task.id, 'term_old', PANE_OLD)
    db.abandonWorkerDispatch(abandoned)
    startWorker(task.id, 'term_new', PANE_NEW, abandoned)
    return abandoned
  }

  it('tells the old worker it lost the Dispatch instead of answering "no mail"', async () => {
    retriedOntoAnotherTerminal()

    await expect(check('term_old', PANE_OLD)).rejects.toMatchObject({
      code: 'consumer_fenced',
      message: expect.stringContaining('no longer owns its Dispatch')
    })
  })

  // The direct mailbox is the old terminal's own, so inspection stays open; only the consuming
  // read that a worker treats as a checkpoint is refused.
  it('still lets the old worker inspect its direct mailbox with --peek and --all', async () => {
    retriedOntoAnotherTerminal()
    db.insertMessage({ from: 'term_coord', to: 'term_old', subject: 'stand down' })

    const peeked = await check('term_old', PANE_OLD, { peek: true })
    const history = await check('term_old', PANE_OLD, { all: true })

    expect(peeked.count).toBe(1)
    expect(history.count).toBe(1)
    expect(db.getUnreadMessages('term_old')).toHaveLength(1)
  })

  it('fences a terminal whose Attempt failed with no successor', async () => {
    ;({ db, ctx } = h.setup())
    const task = db.createTask({ spec: 'work that failed outright' })
    const dispatch = createRootDispatch(db, task.id, 'term_old', PANE_OLD)
    db.failDispatch(dispatch.id, 'worker terminal closed')

    await expect(check('term_old', PANE_OLD)).rejects.toMatchObject({ code: 'consumer_fenced' })
  })

  // A superseded worker whose pane is gone cannot run-use either; the stop signal outranks the
  // rebind advice, and a caller with no settled Attempt still gets the rebind advice.
  it('fences a paneless caller whose Attempt was superseded, and only that caller', async () => {
    retriedOntoAnotherTerminal()

    await expect(
      h.call('orchestration.check', { terminal: 'term_old' }, ctx)
    ).rejects.toMatchObject({ code: 'consumer_fenced' })
    await expect(
      h.call('orchestration.check', { terminal: 'term_never_dispatched' }, ctx)
    ).rejects.toMatchObject({ code: 'stable_pane_required' })
  })

  it('keeps serving direct mail to a terminal whose Attempt completed normally', async () => {
    ;({ db, ctx } = h.setup())
    const task = db.createTask({ spec: 'work that finished' })
    const dispatch = createRootDispatch(db, task.id, 'term_old', PANE_OLD)
    db.completeDispatch(dispatch.id)
    db.insertMessage({ from: 'term_coord', to: 'term_old', subject: 'one more thing' })

    const result = await check('term_old', PANE_OLD)

    expect(result.messages.map((message) => message.subject)).toEqual(['one more thing'])
    expect(db.getUnreadMessages('term_old')).toEqual([])
  })

  it('serves the new owner its Dispatch mailbox as usual', async () => {
    const abandoned = retriedOntoAnotherTerminal()
    const current = db.getDispatchContext(db.getDispatchContextById(abandoned)!.task_id)!
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${current.id}`,
      subject: 'carry on',
      runId: current.run_id
    })

    const result = await check('term_new', PANE_NEW)

    expect(result.messages.map((message) => message.subject)).toEqual(['carry on'])
  })
})
