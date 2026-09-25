/**
 * A structured session runs turn by turn through a shell tool with its own timeout, so the host
 * refuses a blocking `check --wait` from any session caller instead of leaving the rule to the guide.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import {
  createSessionCallerHarness,
  isRecord,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  SESSION_Y,
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
    const failure: unknown = response
    const message = isRecord(failure) && isRecord(failure.error) ? failure.error.message : ''
    expect(message).toContain('Run check without --wait')
    expect(message).toContain('end your turn')
    expect(waitForMessage).not.toHaveBeenCalled()
  })

  it('refuses a structured worker session too: every session runs turn by turn', async () => {
    structuredWorkerIdentities.register({
      handle: mintStructuredWorkerHandle(),
      sessionId: SESSION_Y,
      agent: 'claude',
      paneKey: mintStructuredWorkerPaneKey(SESSION_Y),
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })

    const response = await h.dispatch(
      orchestrationRequest(
        'orchestration.check',
        { wait: true, timeoutMs: 1_000 },
        { sessionId: SESSION_Y }
      )
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'wait_requires_terminal' } })
  })

  it('still answers the same chat a non-waiting check', async () => {
    const result = resultOf(await check({}))

    expect(result.timedOut).not.toBe(true)
  })
})
