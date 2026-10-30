import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from '../../../../orchestration/db/messages/mailbox-routing-page'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

const LEAD = 'tab_lead:22222222-2222-4222-9222-222222222222'
const OTHER = 'tab_other:33333333-3333-4333-8333-333333333333'

function deliveryId(result: unknown): string {
  if (
    typeof result === 'object' &&
    result !== null &&
    'deliveryId' in result &&
    typeof result.deliveryId === 'string'
  ) {
    return result.deliveryId
  }
  throw new Error('Expected a Delivery')
}

describe('Run binding during Dispatch checks', () => {
  const h = createOrchestrationRpcHarness()
  let state: ReturnType<typeof h.setup>
  let dispatch: ReturnType<typeof createRootDispatch>

  beforeEach(() => {
    state = h.setup()
    vi.mocked(state.runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_lead' ? LEAD : handle === 'term_coord' ? h.coordinatorPaneKey : OTHER
    )
    dispatch = createRootDispatch(
      state.db,
      state.db.createTask({ spec: 'lead' }).id,
      'term_lead',
      LEAD
    )
  })
  afterEach(() => {
    state.runtime.cancelMessageWaiters(`dispatch:${dispatch.id}`)
    h.cleanup()
    vi.restoreAllMocks()
  })

  function check(params: Record<string, unknown> = {}) {
    return h.call('orchestration.check', { terminal: 'term_lead', ...params }, state.ctx)
  }
  function residual(subject: string) {
    return state.db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      runId: dispatch.run_id,
      subject
    })
  }
  // A Run this lead created earlier and that lost its binding: the one kind a worker may resume.
  function orphanedOwnRun(): string {
    const id = state.db.createRun({
      objective: 'resume',
      coordinatorHandle: 'term_lead',
      coordinatorPaneKey: LEAD
    }).id
    state.db.db
      .prepare(
        'UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL WHERE id = ?'
      )
      .run(id)
    return id
  }
  async function bind(method: 'runCreate' | 'runUse') {
    const params = method === 'runCreate' ? { objective: 'child' } : { id: orphanedOwnRun() }
    await h.call(`orchestration.${method}`, { from: 'term_lead', ...params }, state.ctx)
    const run = state.db.getCurrentRunForPane(LEAD)
    if (!run) {
      throw new Error('Expected bound Run')
    }
    return run
  }

  it('keeps a notified worker check alive through real reservation and asynchronous inactive-mail routing, then retires it', async () => {
    const mailbox = `dispatch:${dispatch.id}`
    const routeInitial = state.db.getLatestUnreadDirectMessageSequenceForRun.bind(state.db)
    const initialScopes: boolean[] = []
    vi.spyOn(state.db, 'getLatestUnreadDirectMessageSequenceForRun').mockImplementation(
      (...args) => {
        initialScopes.push(state.runtime.messageWaitersByHandle.has(mailbox))
        return routeInitial(...args)
      }
    )
    const pending = check({ wait: true, timeoutMs: 10000 })
    await vi.waitFor(() =>
      expect(
        [...(state.runtime.messageWaitersByHandle.get(mailbox) ?? [])].filter(
          (waiter) => waiter.timeout !== null
        )
      ).toHaveLength(1)
    )
    expect(initialScopes.length).toBeGreaterThan(0)
    expect(initialScopes.every(Boolean)).toBe(true)
    const reserve = state.db.getOrCreateMailboxDelivery.bind(state.db)
    const opportunities: boolean[] = []
    vi.spyOn(state.db, 'getOrCreateMailboxDelivery').mockImplementation((input) => {
      opportunities.push(
        [...(state.runtime.messageWaitersByHandle.get(mailbox) ?? [])].some(
          (waiter) => waiter.notified
        )
      )
      return reserve(input)
    })
    const first = residual('consuming first')
    const second = residual('consuming second')
    state.runtime.notifyMessageArrived(mailbox, first.type)
    const delivery = await pending
    expect(delivery).toMatchObject({ count: 2, messages: [{ id: first.id }, { id: second.id }] })
    expect(opportunities).toEqual([true])
    expect(state.runtime.messageWaitersByHandle.has(mailbox)).toBe(false)
    expect(await check()).toMatchObject({ deliveryId: deliveryId(delivery), replayed: true })
    expect(await check({ ack: deliveryId(delivery) })).toMatchObject({ count: 0 })
    expect([first, second].every((row) => state.db.getMessageById(row.id)?.read === 1)).toBe(true)
    const inactive = check({ wait: true, timeoutMs: 10000 })
    const rejected = expect(inactive).rejects.toMatchObject({ code: 'dispatch_inactive' })
    await vi.waitFor(() =>
      expect(
        [...(state.runtime.messageWaitersByHandle.get(mailbox) ?? [])].filter(
          (waiter) => waiter.timeout !== null
        )
      ).toHaveLength(1)
    )
    const routed: boolean[] = []
    const route = state.db.routeUnreadDispatchMailboxToRunMailbox.bind(state.db)
    vi.spyOn(state.db, 'routeUnreadDispatchMailboxToRunMailbox').mockImplementation((...args) => {
      routed.push(
        [...(state.runtime.messageWaitersByHandle.get(mailbox) ?? [])].some(
          (waiter) => waiter.notified
        )
      )
      return route(...args)
    })
    const tail = Array.from({ length: ORCHESTRATION_DELIVERY_BATCH_LIMIT + 1 }, (_, n) =>
      residual(`routing ${n}`)
    )
    state.db.db
      .prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?")
      .run(dispatch.id)
    state.runtime.notifyMessageArrived(mailbox, 'status')
    await rejected
    expect(routed.length).toBeGreaterThan(1)
    expect(routed.every(Boolean)).toBe(true)
    expect(state.runtime.messageWaitersByHandle.has(mailbox)).toBe(false)
    expect(
      tail.every((row) => state.db.getMessageById(row.id)?.to_handle === `run:${dispatch.run_id}`)
    ).toBe(true)
  })

  describe.each(['runCreate', 'runUse'] as const)('%s', (method) => {
    it.each(['parked', 'recovering'] as const)(
      'cancels a %s Dispatch wait and preserves its ack',
      async (phase) => {
        const old = residual('before bind')
        const ack = deliveryId(await check())
        const record = vi.fn()
        state.ctx.recordMutationReceipt = record
        const wait = vi.spyOn(state.runtime, 'waitForMessage')
        const waiting = check({ ack, wait: true, timeoutMs: 500 })
        if (phase === 'parked') {
          await vi.waitFor(() =>
            expect(wait).toHaveBeenCalledWith(`dispatch:${dispatch.id}`, expect.anything())
          )
        }
        const run = await bind(method)
        await h.call(
          'orchestration.send',
          {
            from: 'term_coord',
            to: `dispatch:${dispatch.id}`,
            subject: 'after bind'
          },
          state.ctx
        )
        expect(await waiting).toMatchObject({ acknowledged: ack, cancelled: true, timedOut: false })
        expect(record).toHaveBeenCalledWith(expect.objectContaining({ acknowledged: ack }))
        expect(state.db.getMessageById(old.id)).toMatchObject({ run_id: dispatch.run_id, read: 1 })
        expect(await check()).toMatchObject({
          runId: run.id,
          messages: [{ subject: 'after bind' }]
        })
        if (phase === 'recovering') {
          expect(wait).not.toHaveBeenCalled()
        }
      }
    )
  })

  it.each(['before', 'during recovery'] as const)(
    'replays Run delivery created %s residual acknowledgment',
    async (phase) => {
      const ids = Array.from(
        { length: ORCHESTRATION_DELIVERY_BATCH_LIMIT + 1 },
        (_, i) => residual(`old ${i}`).id
      )
      const last = ids.at(-1)
      if (!last) {
        throw new Error('Expected residual tail')
      }
      const ack = deliveryId(await check())
      const run = await bind('runCreate')
      state.db.insertMessage({
        from: 'term_child',
        to: `run:${run.id}`,
        runId: run.id,
        subject: 'Run batch'
      })
      let runDelivery: string | undefined
      const readRun = () => {
        const result = state.db.getOrCreateRunDelivery({
          runId: run.id,
          consumerGeneration: run.consumer_generation
        })
        if (!result) {
          throw new Error('Expected Run delivery')
        }
        runDelivery = result.delivery.id
      }
      if (phase === 'before') {
        runDelivery = deliveryId(await check({ run: run.id }))
      } else {
        state.db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run('term_lead', last)
        const route = state.db.routeUnreadDirectMessagesToDispatchMailbox.bind(state.db)
        vi.spyOn(state.db, 'routeUnreadDirectMessagesToDispatchMailbox').mockImplementationOnce(
          (...args) => {
            const result = route(...args)
            readRun()
            return result
          }
        )
      }
      const result = await check({ ack })
      expect(result).toMatchObject({
        runId: run.id,
        deliveryId: runDelivery,
        acknowledged: ack,
        replayed: true
      })
      expect(state.db.hasOutstandingMailboxDelivery(`dispatch:${dispatch.id}`)).toBe(false)
      for (const id of ids.slice(0, -1)) {
        expect(state.db.getMessageById(id)).toMatchObject({ read: 1, run_id: dispatch.run_id })
      }
      expect(state.db.getMessageById(last)).toMatchObject({ read: 0, run_id: dispatch.run_id })
      expect(await check({ ack })).toMatchObject({ deliveryId: runDelivery, replayed: true })
      const tail = await check({ ack: runDelivery })
      expect(tail).toMatchObject({ runId: dispatch.run_id, messages: [{ id: last }], count: 1 })
      expect(await check({ ack: deliveryId(tail) })).toMatchObject({ count: 0 })
      expect(state.db.getMessageById(last)?.read).toBe(1)
    }
  )
})
