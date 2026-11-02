import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../../../core'
import type { OrchestrationDb, RunRow } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { DispatchContextRow } from '../../../../orchestration/types'
import {
  createRootDispatch,
  reattachDispatchConsumer
} from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

describe('Run delivery history', () => {
  const h = createOrchestrationRpcHarness()
  afterEach(() => h.cleanup())

  it('does not label filtered history as an acknowledgeable delivery', async () => {
    const { db, ctx, activeRunId } = h.setup()
    const params = { terminal: 'term_coord', run: activeRunId, all: true }
    db.insertMessage({
      from: 'worker',
      to: `run:${activeRunId}`,
      runId: activeRunId,
      subject: 'waiting'
    })
    expect(await h.call('orchestration.check', params, ctx)).toMatchObject({
      count: 1
    })
    expect(db.hasOutstandingRunDelivery(activeRunId!)).toBe(false)
    const delivery = db.getOrCreateRunDelivery({
      runId: activeRunId!,
      consumerGeneration: db.getRun(activeRunId!)!.consumer_generation
    })!
    db.insertMessage({
      from: 'worker',
      to: `run:${activeRunId}`,
      runId: activeRunId,
      subject: 'later completion',
      type: 'worker_done'
    })
    const history = await h.call(
      'orchestration.check',
      {
        ...params,
        format: true,
        types: 'worker_done'
      },
      ctx
    )
    expect(history).toMatchObject({ count: 1, messages: [{ subject: 'later completion' }] })
    expect(history).not.toHaveProperty('deliveryId')
    expect(db.hasOutstandingRunDelivery(activeRunId!)).toBe(true)
    expect(db.getMessageById(delivery.messages[0].id)?.read).toBe(0)
  })
})

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
    db.abandonWorkerDispatch(abandoned, 'epoch_test')
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

// A lead is dispatched by a root coordinator and then coordinates its own Run from the same pane.
// That pane's `check` reads its own Run mailbox, so mail meant for it must land there.
describe('mail for a lead whose pane coordinates its own Run', () => {
  const h = createOrchestrationRpcHarness()
  const coordPane = 'tab_coord:11111111-1111-4111-8111-111111111111'
  const leadPane = 'tab_lead:22222222-2222-4222-9222-222222222222'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let rootRun: RunRow
  let dispatch: DispatchContextRow

  afterEach(() => {
    h.cleanup()
  })

  function setup(): void {
    ;({ db, runtime, ctx } = h.setup(false))
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? coordPane : handle === 'term_lead' ? leadPane : null
    )
    rootRun = db.createRun({
      objective: 'root',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: coordPane
    })
    const task = db.createTask({ spec: 'lead the sub-project', runId: rootRun.id })
    dispatch = createRootDispatch(db, task.id, 'term_lead', leadPane)
  }

  function bindLeadRun(): RunRow {
    return db.createRun({
      objective: 'lead',
      coordinatorHandle: 'term_lead',
      coordinatorPaneKey: leadPane
    })
  }

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  async function leadInbox(params: Record<string, unknown> = {}): Promise<unknown> {
    return call('orchestration.check', { terminal: 'term_lead', ...params })
  }

  function deliveryIdOf(result: unknown): string {
    if (
      typeof result === 'object' &&
      result !== null &&
      'deliveryId' in result &&
      typeof result.deliveryId === 'string'
    ) {
      return result.deliveryId
    }
    throw new Error('check returned no delivery')
  }

  it('routes dispatch:<id> mail to the Run the assignee pane now coordinates', async () => {
    setup()
    const leadRun = bindLeadRun()

    const result = await call('orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'Follow-up for the lead'
    })

    expect(result).toMatchObject({
      message: { to_handle: `run:${leadRun.id}`, run_id: leadRun.id },
      warnings: [{ code: 'recipient_run_bound_redirect' }]
    })
    expect(await leadInbox()).toMatchObject({ messages: [{ subject: 'Follow-up for the lead' }] })
  })

  it('still reads dispatch mail that arrived before the pane bound its own Run', async () => {
    setup()
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'Sent before the lead bound a Run',
      runId: rootRun.id
    })
    const leadRun = bindLeadRun()
    db.insertMessage({
      from: 'term_worker',
      to: `run:${leadRun.id}`,
      subject: 'Sub-worker report',
      runId: leadRun.id
    })

    const first = await leadInbox()
    expect(first).toMatchObject({ messages: [{ subject: 'Sent before the lead bound a Run' }] })

    const second = await leadInbox({ ack: deliveryIdOf(first) })
    expect(second).toMatchObject({ messages: [{ subject: 'Sub-worker report' }] })
  })

  it('keeps the --types wake condition when older Dispatch mail does not match it', async () => {
    setup()
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'Older status note',
      type: 'status',
      runId: rootRun.id
    })
    const leadRun = bindLeadRun()
    db.insertMessage({
      from: 'term_worker',
      to: `run:${leadRun.id}`,
      subject: 'Sub-worker finished',
      type: 'worker_done',
      runId: leadRun.id
    })

    const woke = await leadInbox({ wait: true, types: 'worker_done', timeoutMs: 500 })

    expect(woke).toMatchObject({
      runId: leadRun.id,
      messages: [{ subject: 'Sub-worker finished' }]
    })
  })

  it('delivers a reply to a Run-bound sender and wakes its waiting check', async () => {
    setup()
    const leadRun = bindLeadRun()
    const report = db.insertMessage({
      from: 'term_lead',
      to: `run:${rootRun.id}`,
      subject: 'Lead report',
      runId: rootRun.id
    })

    const waiting = leadInbox({ wait: true, timeoutMs: 2_000 })
    const reply = await call('orchestration.reply', {
      id: report.id,
      from: 'term_coord',
      body: 'Decision'
    })

    expect(reply).toMatchObject({
      message: { to_handle: `run:${leadRun.id}`, run_id: leadRun.id }
    })
    expect(await waiting).toMatchObject({
      timedOut: false,
      messages: [{ subject: 'Re: Lead report' }]
    })
  })

  it('keeps dispatch:<id> mail on the Dispatch mailbox while the assignee has no Run', async () => {
    setup()

    const result = await call('orchestration.send', {
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'Plain worker follow-up'
    })

    expect(result).toMatchObject({ message: { to_handle: `dispatch:${dispatch.id}` } })
    expect(result).not.toHaveProperty('warnings')
  })

  it('keeps a reply on the raw handle when the sender has no Run or live pane', async () => {
    setup()
    const note = db.insertMessage({
      from: 'term_offline',
      to: `run:${rootRun.id}`,
      subject: 'Offline note',
      runId: rootRun.id
    })

    const reply = await call('orchestration.reply', {
      id: note.id,
      from: 'term_coord',
      body: 'Ack'
    })

    expect(reply).toMatchObject({ message: { to_handle: 'term_offline', run_id: rootRun.id } })
  })
})

const LEAD = 'tab_lead:22222222-2222-4222-9222-222222222222'
const OTHER = 'tab_other:33333333-3333-4333-8333-333333333333'

function deliveryId(result: unknown): string {
  if (
    typeof result === 'object' &&
    result &&
    'deliveryId' in result &&
    typeof result.deliveryId === 'string'
  ) {
    return result.deliveryId
  }
  throw new Error('Expected a Delivery')
}

describe('Run-bound lead mailbox boundaries', () => {
  const h = createOrchestrationRpcHarness()
  let state: ReturnType<typeof h.setup>
  let dispatch: ReturnType<typeof createRootDispatch>
  let leadRun: ReturnType<typeof state.db.createRun>

  beforeEach(() => {
    state = h.setup()
    vi.mocked(state.runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_lead' ? LEAD : handle === 'term_coord' ? h.coordinatorPaneKey : OTHER
    )
    const task = state.db.createTask({ spec: 'nested lead' })
    dispatch = createRootDispatch(state.db, task.id, 'term_lead', LEAD)
    leadRun = state.db.createRun({
      objective: 'child Run',
      coordinatorHandle: 'term_lead',
      coordinatorPaneKey: LEAD
    })
  })
  afterEach(() => h.cleanup())

  function check(params: Record<string, unknown> = {}) {
    return h.call('orchestration.check', { terminal: 'term_lead', ...params }, state.ctx)
  }
  function residual(subject: string, type: 'status' | 'question' = 'status') {
    return state.db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      runId: dispatch.run_id,
      subject,
      type
    })
  }
  function runMail(subject = 'Run report') {
    return state.db.insertMessage({
      from: 'term_child',
      to: `run:${leadRun.id}`,
      runId: leadRun.id,
      subject,
      type: 'question'
    })
  }
  function handoff() {
    state.db.bindRun({
      runId: leadRun.id,
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: OTHER
    })
  }

  it('recovers old raw-handle replies only from the active Dispatch Run', async () => {
    const old = residual('old reply')
    state.db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run('term_lead', old.id)
    const foreign = state.db.createRun({
      objective: 'unrelated',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: OTHER
    })
    const privateMail = state.db.insertMessage({
      from: 'term_other',
      to: 'term_lead',
      runId: foreign.id,
      subject: 'foreign'
    })
    runMail()
    const first = await check()
    expect(first).toMatchObject({ runId: dispatch.run_id, messages: [{ id: old.id }] })
    expect(await check({ ack: deliveryId(first) })).toMatchObject({
      runId: leadRun.id,
      messages: [{ subject: 'Run report' }]
    })
    expect(state.db.getMessageById(privateMail.id)).toMatchObject({ read: 0, run_id: foreign.id })
  })

  it('treats types as a wake condition and replays the entire residual FIFO batch', async () => {
    residual('older status')
    residual('decision needed', 'question')
    runMail()
    const first = await check({ wait: true, types: 'question' })
    expect(first).toMatchObject({
      messages: [{ subject: 'older status' }, { subject: 'decision needed' }]
    })
    expect(await check({ wait: true, types: 'worker_done' })).toMatchObject({
      deliveryId: deliveryId(first),
      replayed: true
    })
    expect(await check({ ack: deliveryId(first) })).toMatchObject({
      runId: leadRun.id,
      acknowledged: deliveryId(first),
      messages: [{ subject: 'Run report' }]
    })
  })

  it('does not filter a non-waiting consuming residual check', async () => {
    residual('status')
    expect(await check({ types: 'question' })).toMatchObject({ messages: [{ subject: 'status' }] })
  })

  it.each([{ peek: true }, { all: true }])(
    'filters residual inspection without consuming it: %j',
    async (mode) => {
      const status = residual('status')
      residual('question', 'question')
      expect(await check({ ...mode, types: 'question' })).toMatchObject({
        messages: [{ subject: 'question' }]
      })
      expect(state.db.getMessageById(status.id)?.read).toBe(0)
      expect(state.db.hasOutstandingMailboxDelivery(`dispatch:${dispatch.id}`)).toBe(false)
    }
  )

  it('replays an outstanding Run batch before exposing older nonmatching residual mail', async () => {
    residual('status')
    runMail()
    const first = await check({ wait: true, types: 'question' })
    expect(first).toMatchObject({ runId: leadRun.id })
    expect(await check()).toMatchObject({ deliveryId: deliveryId(first), replayed: true })
    expect(await check({ ack: deliveryId(first) })).toMatchObject({
      acknowledged: deliveryId(first),
      messages: [{ subject: 'status' }]
    })
  })

  it('keeps explicit Run checks scoped and refuses the parent Run', async () => {
    const pending = residual('parent mail')
    runMail()
    expect(await check({ run: leadRun.id })).toMatchObject({
      runId: leadRun.id,
      messages: [{ subject: 'Run report' }]
    })
    await expect(check({ run: dispatch.run_id })).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(state.db.getMessageById(pending.id)?.read).toBe(0)
  })

  it('fences a Run handoff during residual direct-mail recovery before delivery or ack', async () => {
    const pending = residual('raw before bind')
    state.db.db
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run('term_lead', pending.id)
    const route = state.db.routeUnreadDirectMessagesToDispatchMailbox.bind(state.db)
    vi.spyOn(state.db, 'routeUnreadDirectMessagesToDispatchMailbox').mockImplementationOnce(
      (...args) => {
        const result = route(...args)
        handoff()
        return result
      }
    )
    await expect(check()).rejects.toMatchObject({ code: 'consumer_fenced' })
    expect(state.db.hasOutstandingMailboxDelivery(`dispatch:${dispatch.id}`)).toBe(false)
    expect(state.db.getMessageById(pending.id)?.read).toBe(0)
  })

  it('records a residual acknowledgment before a Run handoff interrupts the following wait', async () => {
    residual('ack me')
    const first = await check()
    const record = vi.fn()
    state.ctx.recordMutationReceipt = record
    vi.spyOn(state.runtime, 'waitForMessage').mockImplementationOnce(async () => {
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({ acknowledged: deliveryId(first) })
      )
      handoff()
      return 'cancelled'
    })
    expect(await check({ ack: deliveryId(first), wait: true })).toMatchObject({
      acknowledged: deliveryId(first),
      waitInterrupted: 'consumer_fenced',
      messages: []
    })
    expect(state.db.getUnreadMessages(`dispatch:${dispatch.id}`)).toEqual([])
  })

  it('retains the acknowledged receipt if the wait transport throws', async () => {
    residual('ack me')
    const first = await check()
    const record = vi.fn()
    state.ctx.recordMutationReceipt = record
    vi.spyOn(state.runtime, 'waitForMessage').mockRejectedValueOnce(
      new Error('connection interrupted')
    )
    await expect(check({ ack: deliveryId(first), wait: true })).rejects.toThrow(
      'connection interrupted'
    )
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ acknowledged: deliveryId(first) })
    )
    expect(state.db.getUnreadMessages(`dispatch:${dispatch.id}`)).toEqual([])
  })

  it('does not give a reused process the previous assignee mail', async () => {
    reattachDispatchConsumer(state.db, {
      dispatchId: dispatch.id,
      paneKey: LEAD,
      processIncarnation: 'old:pty:1'
    })
    const pending = residual('old process mail')
    runMail()
    expect(await check()).toMatchObject({
      runId: leadRun.id,
      messages: [{ subject: 'Run report' }]
    })
    expect(state.db.getMessageById(pending.id)?.read).toBe(0)
    expect(state.db.hasOutstandingMailboxDelivery(`dispatch:${dispatch.id}`)).toBe(false)
  })

  it('refuses an explicit sender Run that would silently redirect into another Run', async () => {
    await expect(
      h.call(
        'orchestration.send',
        {
          from: 'term_coord',
          to: `dispatch:${dispatch.id}`,
          run: dispatch.run_id,
          subject: 'wrong scope'
        },
        state.ctx
      )
    ).rejects.toMatchObject({ code: 'recipient_run_mismatch' })
    expect(state.db.getInbox()).toEqual([])
  })

  it('wakes a parked Run check for Dispatch mail sent after binding', async () => {
    const waiter = vi.spyOn(state.runtime, 'waitForMessage')
    const waiting = check({ wait: true, timeoutMs: 1_000 })
    await vi.waitFor(() =>
      expect(waiter).toHaveBeenCalledWith(`run:${leadRun.id}`, expect.anything())
    )
    await h.call(
      'orchestration.send',
      { from: 'term_coord', to: `dispatch:${dispatch.id}`, subject: 'wake up' },
      state.ctx
    )
    expect(await waiting).toMatchObject({ timedOut: false, messages: [{ subject: 'wake up' }] })
  })

  it('keeps a canonical Run reply in the recipient Run even across an original thread Run', async () => {
    const note = state.db.insertMessage({
      from: `run:${leadRun.id}`,
      to: `run:${dispatch.run_id}`,
      runId: dispatch.run_id,
      subject: 'report'
    })
    expect(
      await h.call(
        'orchestration.reply',
        { from: 'term_coord', id: note.id, body: 'decision' },
        state.ctx
      )
    ).toMatchObject({ message: { to_handle: `run:${leadRun.id}`, run_id: leadRun.id } })
    expect(await check()).toMatchObject({ messages: [{ subject: 'Re: report' }] })
  })

  it('refuses replies to an inactive canonical Dispatch before reading or inserting mail', async () => {
    const note = state.db.insertMessage({
      from: `dispatch:${dispatch.id}`,
      to: `run:${dispatch.run_id}`,
      runId: dispatch.run_id,
      subject: 'old report'
    })
    state.db.completeDispatch(dispatch.id)
    await expect(
      h.call(
        'orchestration.reply',
        { from: 'term_coord', id: note.id, body: 'too late' },
        state.ctx
      )
    ).rejects.toMatchObject({ code: 'dispatch_inactive' })
    expect(state.db.getMessageById(note.id)?.read).toBe(0)
    expect(state.db.getInbox()).toHaveLength(1)
  })
})
