/**
 * A structured session runs each command under its provider's shell-tool timeout, so the host caps a
 * session caller's blocking `check --wait` below it and answers the normal timed-out result. The
 * coordinator loop a terminal agent runs then works unchanged from a chat; a terminal is uncapped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { capSessionCallerWaitMs } from '../orchestration/session-caller-wait-cap'
import {
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  WORKER_HANDLE,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const CODEX_CAP_MS = 6_000
const TERMINAL_WAIT_MS = 600_000

describe('check --wait from an agent session', () => {
  let h: SessionCallerHarness
  let runId: string

  beforeEach(async () => {
    h = createSessionCallerHarness(hostRef)
    const chat = h.records.get(SESSION_X)!
    h.records.set(SESSION_X, { ...chat, provider: 'codex' })
    const created = resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { objective: 'chat coordinator' },
          { sessionId: SESSION_X }
        )
      )
    )
    runId = idOf(created.run)
  })

  afterEach(() => {
    vi.useRealTimers()
    h.close()
    vi.restoreAllMocks()
  })

  function check(params: Record<string, unknown>) {
    return h.dispatch(orchestrationRequest('orchestration.check', params, { sessionId: SESSION_X }))
  }

  it("returns a Codex chat's empty wait as the normal timed-out result, inside its shell tool", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = check({ wait: true, timeoutMs: TERMINAL_WAIT_MS })
    let settled = false
    void pending.then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(CODEX_CAP_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(resultOf(await pending)).toMatchObject({ runId, count: 0, timedOut: true })
  })

  it('returns at once when mail is already waiting', async () => {
    const waitForMessage = vi.spyOn(h.runtime, 'waitForMessage')
    h.db.insertMessage({ from: 'term_peer', to: `run:${runId}`, runId, subject: 'done' })

    const result = resultOf(await check({ wait: true, timeoutMs: TERMINAL_WAIT_MS }))

    expect(result).toMatchObject({ runId, count: 1, timedOut: false })
    expect(waitForMessage).not.toHaveBeenCalled()
  })

  it("leaves a terminal caller's wait exactly as asked", async () => {
    const waitForMessage = vi.spyOn(h.runtime, 'waitForMessage').mockResolvedValue('timed_out')

    await h.dispatch(
      orchestrationRequest('orchestration.check', {
        terminal: WORKER_HANDLE,
        wait: true,
        timeoutMs: TERMINAL_WAIT_MS
      })
    )

    expect(waitForMessage).toHaveBeenCalledWith(
      WORKER_HANDLE,
      expect.objectContaining({ timeoutMs: TERMINAL_WAIT_MS })
    )
  })
})

describe('the wait cap per provider', () => {
  it('stays below each shell tool, keeps a shorter wait, and leaves a terminal alone', () => {
    const codexChat = testOrcaSessionId('9c2e4a61-3f7b-4d8e-b105-6a2d8e4f1c93')
    const claudeChat = testOrcaSessionId('1d7f3a52-6b8e-4c19-a2d4-7e5f9b3c0a18')
    const records = new Map<string, { provider: string }>([
      [codexChat, { provider: 'codex' }],
      [claudeChat, { provider: 'claude' }]
    ])
    hostRef.current = { deps: { store: { getRecord: (id: string) => records.get(id) ?? null } } }

    expect(capSessionCallerWaitMs(undefined, { sessionId: codexChat })).toBe(CODEX_CAP_MS)
    expect(capSessionCallerWaitMs(TERMINAL_WAIT_MS, { sessionId: claudeChat })).toBe(100_000)
    expect(capSessionCallerWaitMs(2_000, { sessionId: codexChat })).toBe(2_000)
    // An unknown provider gets the shortest cap: an early return is harmless, a kill is not.
    expect(
      capSessionCallerWaitMs(TERMINAL_WAIT_MS, {
        sessionId: testOrcaSessionId('0b6e2d94-5a1c-4f37-8e20-3c9a7d1b5f46')
      })
    ).toBe(CODEX_CAP_MS)
    expect(capSessionCallerWaitMs(TERMINAL_WAIT_MS, undefined)).toBe(TERMINAL_WAIT_MS)
    hostRef.current = null
  })
})
