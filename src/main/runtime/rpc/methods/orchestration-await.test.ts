import { afterEach, describe, expect, it } from 'vitest'
import { AWAIT_MIN_BUDGET_MS } from '../../orchestration/control-plane/coordinator-await-contract'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

const harness = createOrchestrationRpcHarness()

/** B3 (correction 2) — the durable subscription, exercised through the real RPC
 *  method against a real in-memory Run. */
describe('orchestration.await', () => {
  afterEach(() => harness.cleanup())

  it('returns immediately for a worker_done already in the mailbox', async () => {
    const state = harness.setup()
    state.db.insertMessage({
      from: 'term_worker',
      to: `run:${state.activeRunId}`,
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: 't', dispatchId: 'd', outcome: 'succeeded' })
    })
    const result = (await harness.call(
      'orchestration.await',
      { from: 'term_coord' },
      state.ctx
    )) as {
      wakeEvents: { reason: string }[]
      timedOut: boolean
      sweeps: number
    }
    expect(result.timedOut).toBe(false)
    expect(result.wakeEvents.map((event) => event.reason)).toEqual(['worker_done'])
    expect(result.sweeps).toBeGreaterThanOrEqual(1)
  })

  it('wakes for a typed stalled escalation the liveness sweep published', async () => {
    const state = harness.setup()
    state.db.insertMessage({
      from: 'orca:runtime-liveness',
      to: `run:${state.activeRunId}`,
      subject: 'Worker stalled',
      type: 'escalation',
      payload: JSON.stringify({ wakeReason: 'stalled', dispatchId: 'ctx_1' })
    })
    const result = (await harness.call(
      'orchestration.await',
      { from: 'term_coord' },
      state.ctx
    )) as {
      wakeEvents: { reason: string }[]
    }
    expect(result.wakeEvents.map((event) => event.reason)).toEqual(['stalled'])
  })

  it('negative control: a non-actionable mailbox does not end the wait', async () => {
    const state = harness.setup()
    state.db.insertMessage({
      from: 'term_worker',
      to: `run:${state.activeRunId}`,
      subject: 'progress',
      type: 'status'
    })
    state.db.insertMessage({
      from: 'term_worker',
      to: `run:${state.activeRunId}`,
      subject: 'alive',
      type: 'heartbeat',
      payload: JSON.stringify({ dispatchId: 'ctx_1' })
    })
    const controller = new AbortController()
    const pending = harness.call(
      'orchestration.await',
      // timeoutMs is clamped UP to the one-minute floor, so this wait cannot be
      // ended by a 25/30/60-second model window — only by a wake or an abort.
      { from: 'term_coord', timeoutMs: 1, sweepIntervalMs: 500 },
      { ...state.ctx, signal: controller.signal }
    ) as Promise<{ cancelled: boolean; wakeEvents: unknown[]; budgetMs: number }>
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    controller.abort()
    const result = await pending
    expect(result.cancelled).toBe(true)
    expect(result.wakeEvents).toEqual([])
    expect(result.budgetMs).toBe(AWAIT_MIN_BUDGET_MS)
  }, 30_000)

  it('re-arms across slice timeouts and returns when the wake finally arrives', async () => {
    const state = harness.setup()
    const pending = harness.call(
      'orchestration.await',
      { from: 'term_coord', sweepIntervalMs: 1_000 },
      state.ctx
    ) as Promise<{ wakeEvents: { reason: string }[]; sweeps: number }>
    // Arrives after the first slice has already expired at least once.
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    state.db.insertMessage({
      from: 'term_worker',
      to: `run:${state.activeRunId}`,
      subject: 'Blocked',
      type: 'escalation'
    })
    state.runtime.notifyMessageArrived(`run:${state.activeRunId}`, 'escalation')
    const result = await pending
    expect(result.wakeEvents.map((event) => event.reason)).toEqual(['escalation'])
    expect(result.sweeps).toBeGreaterThan(1)
  }, 30_000)

  it('keeps one actionable waiter per Run: a second subscription is refused', async () => {
    const state = harness.setup()
    const controller = new AbortController()
    const first = harness.call(
      'orchestration.await',
      { from: 'term_coord', sweepIntervalMs: 5_000 },
      { ...state.ctx, signal: controller.signal }
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    await expect(
      harness.call('orchestration.await', { from: 'term_coord', sweepIntervalMs: 5_000 }, state.ctx)
    ).rejects.toMatchObject({ code: 'waiter_exists' })
    controller.abort()
    await first
  }, 30_000)

  it('refuses to wait without a bound Run', async () => {
    const state = harness.setup(false)
    await expect(
      harness.call('orchestration.await', { from: 'term_coord' }, state.ctx)
    ).rejects.toMatchObject({ code: 'run_not_bound' })
  })
})
