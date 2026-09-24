/**
 * A chat runs turn by turn through a shell tool with its own timeout, so the host refuses a
 * blocking `check --wait` from it instead of leaving the rule to the guide. The gate is the lease:
 * a session a terminal view holds runs in a PTY, where blocking is legitimate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionCallerHarness,
  isRecord,
  orchestrationRequest,
  resultOf,
  sessionRecord,
  SESSION_X,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

describe('check --wait from an agent session', () => {
  let h: SessionCallerHarness

  beforeEach(async () => {
    h = createSessionCallerHarness(hostRef)
    resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { objective: 'chat coordinator' },
          { sessionId: SESSION_X }
        )
      )
    )
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  function check(params: Record<string, unknown>) {
    return h.dispatch(orchestrationRequest('orchestration.check', params, { sessionId: SESSION_X }))
  }

  it('refuses a native chat before any waiter registers, naming the turn loop', async () => {
    const waitForMessage = vi.spyOn(h.runtime, 'waitForMessage')

    const response = await check({ wait: true, timeoutMs: 1_000 })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'wait_requires_terminal', data: { effectsApplied: false } }
    })
    const message = isRecord(response) && isRecord(response.error) ? response.error.message : ''
    expect(message).toContain('Run check without --wait')
    expect(message).toContain('end your turn')
    expect(waitForMessage).not.toHaveBeenCalled()
  })

  it('still answers the same chat a non-waiting check', async () => {
    const result = resultOf(await check({}))

    expect(result.timedOut).not.toBe(true)
  })

  it('lets a session a terminal view holds block, because it runs in a PTY', async () => {
    h.records.set(SESSION_X, sessionRecord(SESSION_X, { lease: { runtimeKind: 'tui' } }))

    const result = resultOf(await check({ wait: true, timeoutMs: 50 }))

    expect(result.timedOut).toBe(true)
  })
})
