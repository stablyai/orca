import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRootDispatch,
  reattachDispatchConsumer
} from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

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
