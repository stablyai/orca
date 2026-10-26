/** Chat check --wait honors the requested budget; provider shell tools that time out background/yield it rather than killing it. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  resultOf,
  SESSION_X,
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
})
