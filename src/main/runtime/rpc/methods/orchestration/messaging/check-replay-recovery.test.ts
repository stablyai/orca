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

describe('consuming check replay recovery', () => {
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

  function check(terminal: string, params: Record<string, unknown> = {}) {
    return h.call(
      'orchestration.check',
      { terminal, compatibilityCliCommand: 'orca', ...params },
      state.ctx
    )
  }
  function mail(runId: string, address: string, subject: string) {
    return state.db.insertMessage({ from: 'term_worker', to: address, runId, subject })
  }
  function bind() {
    return state.db.createRun({
      objective: 'child',
      coordinatorHandle: 'term_lead',
      coordinatorPaneKey: LEAD
    })
  }

  it.each(['run', 'dispatch'] as const)(
    'returns an exact unbounded count for %s replay, ignoring wake filters and pointer stamps',
    async (kind) => {
      const runId = kind === 'run' ? state.activeRunId : dispatch.run_id
      if (!runId) {
        throw new Error('Expected Run')
      }
      const address = kind === 'run' ? `run:${runId}` : `dispatch:${dispatch.id}`
      const terminal = kind === 'run' ? 'term_coord' : 'term_lead'
      const firstMessage = mail(runId, address, 'first')
      const first = await check(terminal)
      expect(first).not.toHaveProperty('replayRecovery')
      const waiting = Array.from({ length: 73 }, (_, i) => mail(runId, address, `later ${i}`))
      state.db.markAsDelivered(waiting.map((message) => message.id))
      const read = mail(runId, address, 'already read')
      state.db.markAsRead([read.id])
      state.db.insertMessage({
        from: 'term_worker',
        to: address,
        runId,
        subject: 'audit',
        deliveryContract: 'audit_only'
      })
      state.db.insertMessage({
        from: 'term_worker',
        to: address,
        runId,
        subject: 'legacy',
        deliveryContract: 'legacy_direct'
      })
      mail(runId, 'unrelated', 'different mailbox')
      const replay = await check(terminal, {
        wait: true,
        types: 'question',
        compatibilityCliCommand: 'orca-ide'
      })
      expect(replay).toMatchObject({
        deliveryId: deliveryId(first),
        count: 1,
        replayed: true,
        messages: [{ id: firstMessage.id }],
        replayRecovery: {
          waitingCount: 73,
          ackCommand: `orca-ide orchestration check --terminal ${terminal} --ack ${deliveryId(first)}`,
          guidance:
            'Process every message in this batch before acknowledging, then process the next batch returned.'
        }
      })
      expect(JSON.parse(JSON.stringify(replay))).toHaveProperty('replayRecovery.waitingCount', 73)
      const next = await check(terminal, { ack: deliveryId(first) })
      expect(next).toMatchObject({ acknowledged: deliveryId(first), count: 50, replayed: false })
      expect(next).not.toHaveProperty('replayRecovery')
      expect(await check(terminal, { ack: deliveryId(first) })).toMatchObject({
        deliveryId: deliveryId(next),
        replayed: true,
        replayRecovery: { waitingCount: 23 }
      })
    }
  )

  it('reports zero waiting rows without modifying the replayed batch', async () => {
    mail(dispatch.run_id, `dispatch:${dispatch.id}`, 'only')
    const first = await check('term_lead')
    expect(await check('term_lead')).toMatchObject({
      deliveryId: deliveryId(first),
      replayed: true,
      replayRecovery: { waitingCount: 0 }
    })
    expect(state.db.getDeliveryRaw(deliveryId(first))?.status).toBe('outstanding')
  })

  it('counts valid residual Dispatch mail deferred by Run replay without changing FIFO ownership', async () => {
    const run = bind()
    mail(run.id, `run:${run.id}`, 'Run first')
    const first = await check('term_lead', { run: run.id })
    mail(run.id, `run:${run.id}`, 'Run later')
    const residual = Array.from({ length: 61 }, (_, i) =>
      mail(dispatch.run_id, `dispatch:${dispatch.id}`, `residual ${i}`)
    )
    state.db.markAsDelivered(residual.map((message) => message.id))
    const rawResidual = residual.at(-1)
    if (!rawResidual) {
      throw new Error('Expected residual mail')
    }
    state.db.db
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run('term_lead', rawResidual.id)
    expect(await check('term_lead')).toMatchObject({
      deliveryId: deliveryId(first),
      replayed: true,
      replayRecovery: {
        waitingCount: 62,
        ackCommand: `orca orchestration check --terminal term_lead --ack ${deliveryId(first)}`
      }
    })
    expect(await check('term_lead', { run: run.id })).toMatchObject({
      replayRecovery: {
        waitingCount: 1,
        ackCommand: `orca orchestration check --terminal term_lead --run ${run.id} --ack ${deliveryId(first)}`
      }
    })
    const tail = await check('term_lead', { ack: deliveryId(first) })
    expect(tail).toMatchObject({
      runId: dispatch.run_id,
      messages: residual.slice(0, 50).map((message) => ({ id: message.id }))
    })
    const replay = await check('term_lead')
    expect(replay).toMatchObject({
      deliveryId: deliveryId(tail),
      replayRecovery: {
        ackCommand: `orca orchestration check --terminal term_lead --ack ${deliveryId(tail)}`
      }
    })
    const residualNext = await check('term_lead', { ack: deliveryId(tail) })
    expect(residualNext).toMatchObject({ runId: dispatch.run_id, count: 11 })
    expect(await check('term_lead', { ack: deliveryId(residualNext) })).toMatchObject({
      runId: run.id,
      messages: [{ subject: 'Run later' }]
    })
  })

  it('does not count an old residual Dispatch after its process identity was replaced', async () => {
    const run = bind()
    mail(run.id, `run:${run.id}`, 'Run batch')
    const first = await check('term_lead', { run: run.id })
    mail(dispatch.run_id, `dispatch:${dispatch.id}`, 'private old mail')
    reattachDispatchConsumer(state.db, {
      dispatchId: dispatch.id,
      paneKey: LEAD,
      processIncarnation: 'old:pty:1'
    })
    expect(await check('term_lead')).toMatchObject({
      deliveryId: deliveryId(first),
      replayRecovery: { waitingCount: 0 }
    })
  })

  it.each([{ peek: true }, { all: true }, { unread: false }])(
    'omits recovery for inspection %j',
    async (mode) => {
      mail(dispatch.run_id, `dispatch:${dispatch.id}`, 'first')
      await check('term_lead')
      mail(dispatch.run_id, `dispatch:${dispatch.id}`, 'later')
      expect(await check('term_lead', mode)).not.toHaveProperty('replayRecovery')
    }
  )

  it('refuses a fenced consumer before returning recovery', async () => {
    mail(dispatch.run_id, `dispatch:${dispatch.id}`, 'first')
    await check('term_lead')
    reattachDispatchConsumer(state.db, {
      dispatchId: dispatch.id,
      paneKey: OTHER,
      processIncarnation: 'replacement:1'
    })
    await expect(check('term_lead')).rejects.toMatchObject({ code: 'consumer_fenced' })
  })

  it('keeps the batch and ack guidance available if deriving the waiting count fails', async () => {
    mail(dispatch.run_id, `dispatch:${dispatch.id}`, 'first')
    const first = await check('term_lead')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(state.db, 'countUnreadMessagesOutsideDelivery').mockImplementation(() => {
      throw new Error('count unavailable')
    })
    const replay = await check('term_lead')
    expect(replay).toMatchObject({
      deliveryId: deliveryId(first),
      count: 1,
      replayRecovery: {
        ackCommand: `orca orchestration check --terminal term_lead --ack ${deliveryId(first)}`
      }
    })
    expect(replay).not.toHaveProperty('replayRecovery.waitingCount')
    expect(warn).toHaveBeenCalled()
  })

  it('omits the entire waiting count if deferred residual ownership cannot be projected', async () => {
    const run = bind()
    mail(run.id, `run:${run.id}`, 'Run batch')
    const first = await check('term_lead', { run: run.id })
    mail(dispatch.run_id, `dispatch:${dispatch.id}`, 'residual')
    const lookup = state.db.getActiveDispatchForIdentity.bind(state.db)
    vi.spyOn(state.db, 'getActiveDispatchForIdentity')
      .mockImplementationOnce(lookup)
      .mockImplementationOnce(() => {
        throw new Error('residual projection unavailable')
      })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const replay = await check('term_lead')
    expect(replay).toMatchObject({
      deliveryId: deliveryId(first),
      count: 1,
      messages: [{ subject: 'Run batch' }],
      replayRecovery: {
        ackCommand: `orca orchestration check --terminal term_lead --ack ${deliveryId(first)}`
      }
    })
    expect(replay).not.toHaveProperty('replayRecovery.waitingCount')
    expect(warn).toHaveBeenCalled()
  })
})
