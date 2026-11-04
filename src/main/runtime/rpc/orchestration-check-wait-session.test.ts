/** Chat check --wait honors the requested budget; provider shell tools that time out background/yield it rather than killing it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  SESSION_Y,
  WORKER_HANDLE,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

describe('check --wait from an agent session', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  it('waits the budget a chat asked for, as it would for a terminal', async () => {
    const asX = (method: string, params: Record<string, unknown>) =>
      h.dispatch(orchestrationRequest(method, params, { sessionId: SESSION_X }))
    const runId = idOf(resultOf(await asX('orchestration.runCreate', { objective: 'o' })).run)
    const waitForMessage = vi.spyOn(h.runtime, 'waitForMessage').mockResolvedValue('timed_out')

    const result = resultOf(await asX('orchestration.check', { wait: true, timeoutMs: 600_000 }))

    expect(result).toMatchObject({ runId, count: 0, timedOut: true })
    expect(waitForMessage).toHaveBeenCalledWith(
      `run:${runId}`,
      expect.objectContaining({ timeoutMs: 600_000 })
    )
  })

  it('lets a chat hold two waits that share one Delivery and are both fenced on takeover', async () => {
    const as = (sessionId: string | undefined, method: string, params: Record<string, unknown>) =>
      h.dispatch(orchestrationRequest(method, params, { sessionId }))
    const runId = idOf(
      resultOf(await as(SESSION_X, 'orchestration.runCreate', { objective: 'o' })).run
    )
    const waiter = vi.spyOn(h.runtime, 'waitForMessage')
    const parkTwoWaits = async () => {
      const parked = waiter.mock.calls.length + 2
      const waits = Promise.all(
        [1, 2].map(() =>
          as(SESSION_X, 'orchestration.check', { run: runId, wait: true, timeoutMs: 5_000 })
        )
      )
      await vi.waitFor(() => expect(waiter).toHaveBeenCalledTimes(parked))
      return { settled: waits }
    }

    const shared = await parkTwoWaits()
    await as(undefined, 'orchestration.send', {
      from: WORKER_HANDLE,
      to: `run:${runId}`,
      subject: 'done',
      run: runId
    })
    const [first, second] = (await shared.settled).map(resultOf)
    expect(first.deliveryId).toEqual(expect.any(String))
    expect(second.deliveryId).toBe(first.deliveryId)
    await as(SESSION_X, 'orchestration.check', { run: runId, ack: first.deliveryId })

    const fenced = await parkTwoWaits()
    await as(SESSION_Y, 'orchestration.runUse', { id: runId })
    const fencedError = { ok: false, error: expect.objectContaining({ code: 'consumer_fenced' }) }
    expect(await fenced.settled).toEqual([
      expect.objectContaining(fencedError),
      expect.objectContaining(fencedError)
    ])
  })
})
