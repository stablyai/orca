import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from '../../../../orchestration/db/messages/mailbox-routing-page'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { RpcDispatcher } from '../../../dispatcher'
import { ORCHESTRATION_METHODS } from '../orchestration'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { resultOf } from '../../../orchestration/callers/session.test-fixture'

const LEAD = 'tab_lead:22222222-2222-4222-9222-222222222222'
const OTHER = 'tab_other:33333333-3333-4333-8333-333333333333'

const checkResult = z.object({
  deliveryId: z.string().nullable(),
  count: z.number(),
  messages: z.array(z.object({ subject: z.string() }).passthrough()),
  acknowledged: z.string().nullable(),
  formatted: z.string().optional()
})
type CheckResult = z.infer<typeof checkResult>

describe('consuming checks', () => {
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
    h.cleanup()
    vi.restoreAllMocks()
  })

  async function check(
    params: Record<string, unknown> = {},
    ctx = state.ctx
  ): Promise<CheckResult> {
    return checkResult.parse(
      await h.call('orchestration.check', { terminal: 'term_lead', ...params }, ctx)
    )
  }
  async function mailbox(kind: 'dispatch' | 'run') {
    if (kind === 'dispatch') {
      return { address: `dispatch:${dispatch.id}`, runId: dispatch.run_id }
    }
    await h.call('orchestration.runCreate', { from: 'term_lead', objective: 'child' }, state.ctx)
    const run = state.db.getCurrentRunForPane(LEAD)
    if (!run) {
      throw new Error('Expected bound Run')
    }
    return { address: `run:${run.id}`, runId: run.id }
  }
  function insert(box: { address: string; runId: string }, subject: string, type = 'status') {
    return state.db.insertMessage({
      from: 'term_coord',
      to: box.address,
      runId: box.runId,
      subject,
      type: type === 'question' ? 'question' : 'status'
    })
  }

  describe.each(['dispatch', 'run'] as const)('on a %s mailbox', (kind) => {
    it.each([true, false])(
      'shares a whole batch with each waiter’s own format and receipt (first formatted: %s)',
      async (firstFormatted) => {
        const box = await mailbox(kind)
        insert(box, 'handled before waiting')
        const handled = await check()
        const waits = vi.spyOn(state.runtime, 'waitForMessage')
        const dispatcher = new RpcDispatcher({
          runtime: state.runtime,
          methods: ORCHESTRATION_METHODS
        })
        const requests = [0, 1].map((index) => ({
          id: `rpc-wait-${index}`,
          authToken: 'test-token',
          method: 'orchestration.check',
          orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
          orchestrationRequestId: `mutation-wait-${index}`,
          params: {
            terminal: 'term_lead',
            wait: true,
            timeoutMs: 5_000,
            format: index === 0 ? firstFormatted : !firstFormatted,
            ...(index === 0 ? { ack: handled.deliveryId } : {})
          }
        }))
        const waiting = requests.map((request) => dispatcher.dispatch(request))
        await vi.waitFor(() => expect(waits).toHaveBeenCalledTimes(2))
        for (let index = 0; index <= ORCHESTRATION_DELIVERY_BATCH_LIMIT; index += 1) {
          insert(box, `report ${index}`)
        }
        state.runtime.notifyMessageArrived(box.address, 'status')

        const responses = await Promise.all(waiting)
        const [first, second] = responses.map((response) => checkResult.parse(resultOf(response)))
        expect(first.count).toBe(ORCHESTRATION_DELIVERY_BATCH_LIMIT)
        expect(second).toMatchObject({ deliveryId: first.deliveryId, count: first.count })
        expect(first).toMatchObject({ acknowledged: handled.deliveryId })
        expect(second).toMatchObject({ acknowledged: null })
        const formatted = firstFormatted ? first : second
        const plain = firstFormatted ? second : first
        expect(formatted).toMatchObject({ formatted: expect.stringContaining('report 0') })
        expect(plain).not.toHaveProperty('formatted')
        for (const [index, request] of requests.entries()) {
          expect(await dispatcher.dispatch(request)).toEqual({
            ...responses[index],
            result: {
              ...resultOf(responses[index]),
              mutation: { requestId: request.orchestrationRequestId, replayed: true }
            }
          })
        }
        expect(state.db.getUnreadMessages(box.address)).toHaveLength(1)
      }
    )

    it('keeps a shared raw claim after its whole mail leaves the outstanding view', async () => {
      const box = await mailbox(kind)
      const waits = vi.spyOn(state.runtime, 'waitForMessage')
      const receipts = [vi.fn(), vi.fn()]
      const waiting = receipts.map((recordMutationReceipt) =>
        check({ wait: true }, { ...state.ctx, recordMutationReceipt })
      )
      await vi.waitFor(() => expect(waits).toHaveBeenCalledTimes(2))
      const original = insert(box, 'already delivered whole')
      const select = state.db.getOrCreateMailboxDelivery.bind(state.db)
      vi.spyOn(state.db, 'getOrCreateMailboxDelivery').mockImplementationOnce((params) => {
        const claim = select(params)
        // Whole-delivery settlement hides D before either notified check can finalize it.
        state.db.markAsRead([original.id])
        insert(box, 'arrived after the claim')
        return claim
      })
      state.runtime.notifyMessageArrived(box.address, 'status')
      const [first, second] = await Promise.all(waiting)
      expect(first).toMatchObject({ count: 0, messages: [] })
      expect(first.deliveryId).toMatch(/^delivery_/)
      expect(second).toMatchObject({ deliveryId: first.deliveryId, count: 0, messages: [] })
      expect(state.db.getDeliveryRaw(first.deliveryId!)?.message_ids).toBe('[]')
      expect(state.db.getUnreadMessages(box.address)).toMatchObject([
        { subject: 'arrived after the claim' }
      ])
      for (const receipt of receipts) {
        expect(receipt).toHaveBeenLastCalledWith(
          expect.objectContaining({
            deliveryId: first.deliveryId,
            count: 0,
            messages: []
          })
        )
      }
    })

    it('never hands a woken filtered waiter a batch from before its wake', async () => {
      const box = await mailbox(kind)
      const realWaitForMessage = state.runtime.waitForMessage.bind(state.runtime)
      vi.spyOn(state.runtime, 'waitForMessage').mockImplementationOnce(async (...args) => {
        const result = await realWaitForMessage(...args)
        // Another consumer takes the question batch before this waiter resumes.
        expect(await check()).toMatchObject({ messages: [{ subject: 'question' }] })
        return result
      })
      const waiting = check({ wait: true, types: 'question', timeoutMs: 5_000 })
      await vi.waitFor(() => expect(state.runtime.waitForMessage).toHaveBeenCalled())
      insert(box, 'status')
      expect(await check()).toMatchObject({ messages: [{ subject: 'status' }] })
      insert(box, 'question', 'question')
      state.runtime.notifyMessageArrived(box.address, 'question')

      expect(await waiting).toMatchObject({ deliveryId: null, count: 0 })
    })
  })

  it.each(['inside the take', 'after its next authority check'] as const)(
    'returns and receipts residual mail it took when the Run is fenced %s',
    async (when) => {
      const residual = insert({ address: `dispatch:${dispatch.id}`, runId: dispatch.run_id }, 'old')
      const run = (await mailbox('run')).runId
      const record = vi.fn()
      state.ctx.recordMutationReceipt = record
      const fence = () =>
        state.db.db
          .prepare('UPDATE runs SET consumer_generation = consumer_generation + 1 WHERE id = ?')
          .run(run)
      const take = state.db.finalizeMailboxDelivery.bind(state.db)
      const getRun = state.db.getRun.bind(state.db)
      let fenceOnNextRead = false
      vi.spyOn(state.db, 'finalizeMailboxDelivery').mockImplementationOnce((params) => {
        const taken = take(params)
        if (when === 'inside the take') {
          fence()
        } else {
          fenceOnNextRead = true
        }
        return taken
      })
      // The takeover lands between an authority check that passes and the next one.
      vi.spyOn(state.db, 'getRun').mockImplementation((id) => {
        if (fenceOnNextRead) {
          fenceOnNextRead = false
          queueMicrotask(fence)
        }
        return getRun(id)
      })

      const result = await check()
      expect(result).toMatchObject({ count: 1, messages: [{ subject: 'old' }] })
      expect(record).toHaveBeenLastCalledWith(
        expect.objectContaining({ deliveryId: result.deliveryId, messages: result.messages })
      )
      expect(state.db.getMessageById(residual.id)?.read).toBe(1)
    }
  )

  it.each([
    { kind: 'run', wait: false },
    { kind: 'run', wait: true },
    { kind: 'dispatch', wait: false },
    { kind: 'dispatch', wait: true }
  ] as const)(
    'acknowledges $kind mail with --ack and takes newer mail only with --wait ($wait)',
    async ({ kind, wait }) => {
      const box = await mailbox(kind)
      insert(box, 'handled')
      const handled = await check()
      const report = insert(box, 'stop report')

      const acked = await h.call(
        'orchestration.check',
        { terminal: 'term_lead', ack: handled.deliveryId, wait },
        state.ctx
      )
      expect(state.db.getDeliveryRaw(handled.deliveryId ?? '')?.status).toBe('acknowledged')
      if (wait) {
        expect(acked).toMatchObject({
          acknowledged: handled.deliveryId,
          messages: [{ subject: 'stop report' }]
        })
        expect(state.db.getMessageById(report.id)?.read).toBe(1)
        return
      }
      expect(acked).toMatchObject({
        acknowledged: handled.deliveryId,
        deliveryId: null,
        count: 0,
        next: expect.stringContaining('--ack is not needed')
      })
      expect(state.db.getMessageById(report.id)?.read).toBe(0)
      expect(await check()).toMatchObject({ messages: [{ subject: 'stop report' }] })
    }
  )

  it('rejects --ack on direct mail, which has no Delivery, and takes nothing', async () => {
    const mail = state.db.insertMessage({ from: 'term_coord', to: 'term_other', subject: 'direct' })
    await expect(
      h.call('orchestration.check', { terminal: 'term_other', ack: 'delivery_foreign' }, state.ctx)
    ).rejects.toMatchObject({ code: 'stale_delivery' })
    expect(state.db.getMessageById(mail.id)?.read).toBe(0)
  })

  it('leaves its exact claim and mail unread when final receipt recording rolls back', async () => {
    const box = { address: `dispatch:${dispatch.id}`, runId: dispatch.run_id }
    const mail = insert(box, 'receipt must commit')
    await expect(
      check(
        {},
        {
          ...state.ctx,
          recordMutationReceipt: () => {
            throw new Error('receipt failed')
          }
        }
      )
    ).rejects.toThrow('receipt failed')
    expect(state.db.getMessageById(mail.id)?.read).toBe(0)
    expect(state.db.getOutstandingMailboxDelivery(box.address)?.messageIds).toEqual([mail.id])
    expect(await check()).toMatchObject({ messages: [{ subject: 'receipt must commit' }] })
  })

  it('lets a same-wake sibling commit the claim after the first receipt rolls back', async () => {
    const box = { address: `dispatch:${dispatch.id}`, runId: dispatch.run_id }
    const waits = vi.spyOn(state.runtime, 'waitForMessage')
    const failed = check(
      { wait: true },
      {
        ...state.ctx,
        recordMutationReceipt: () => {
          throw new Error('receipt failed')
        }
      }
    )
    const sibling = check({ wait: true })
    const results = Promise.allSettled([failed, sibling])
    await vi.waitFor(() => expect(waits).toHaveBeenCalledTimes(2))
    const mail = insert(box, 'commit after rollback')
    state.runtime.notifyMessageArrived(box.address, 'status')
    const [first, second] = await results
    expect(first).toMatchObject({ status: 'rejected', reason: { message: 'receipt failed' } })
    expect(second).toMatchObject({
      status: 'fulfilled',
      value: { messages: [{ subject: 'commit after rollback' }] }
    })
    expect(state.db.getMessageById(mail.id)?.read).toBe(1)
    expect(state.db.getOutstandingMailboxDelivery(box.address)).toBeUndefined()
  })

  it('rolls the take back when its receipt cannot be recorded', () => {
    const box = { address: `dispatch:${dispatch.id}`, runId: dispatch.run_id }
    const message = insert(box, 'kept')
    expect(() =>
      state.db.takeMailboxDelivery({
        runId: box.runId,
        mailboxHandle: box.address,
        consumerGeneration: dispatch.consumer_generation,
        recordTaken: () => {
          throw new Error('receipt write failed')
        }
      })
    ).toThrow('receipt write failed')
    expect(state.db.getMessageById(message.id)?.read).toBe(0)
    expect(state.db.hasOutstandingMailboxDelivery(box.address)).toBe(false)
  })
})
