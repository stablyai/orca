import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionCallerHarness,
  orchestrationRequest,
  idOf,
  resultOf,
  SESSION_X,
  SESSION_Y,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

describe('session Run creation protects the current binding', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
  })
  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  it('returns an actionable wire error without blocking another coordinator', async () => {
    const first = await h.dispatch(
      orchestrationRequest(
        'orchestration.runCreate',
        { objective: 'Current work' },
        { sessionId: SESSION_X }
      )
    )
    const runId = idOf(resultOf(first).run)
    const prior = h.db.getRun(runId)
    const refused = await h.dispatch(
      orchestrationRequest(
        'orchestration.runCreate',
        { objective: 'Probe' },
        { sessionId: SESSION_X }
      )
    )
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'run_already_bound', data: { runId, effectsApplied: false } }
    })
    expect(h.db.getRun(runId)).toEqual(prior)
    const other = await h.dispatch(
      orchestrationRequest(
        'orchestration.runCreate',
        { objective: 'Independent work' },
        { sessionId: SESSION_Y }
      )
    )
    expect(other).toMatchObject({ ok: true })
    expect(h.db.getRun(runId)).toEqual(prior)

    const replacement = await h.dispatch(
      orchestrationRequest(
        'orchestration.runCreate',
        { objective: 'Replacement', replaceCurrent: true },
        { sessionId: SESSION_X }
      )
    )
    expect(replacement).toMatchObject({ ok: true })
    expect(h.db.getRun(runId)?.coordinator_orca_session_id).toBeNull()
    expect(h.db.getRun(idOf(resultOf(replacement).run))?.coordinator_orca_session_id).toBe(
      SESSION_X
    )
  })

  it('replays an exact successful mutation instead of rejecting its new binding', async () => {
    const params = { objective: 'Recover the receipt' }
    const options = { sessionId: SESSION_X, requestId: 'create-run-retry' }
    const first = await h.dispatch(orchestrationRequest('orchestration.runCreate', params, options))
    const runId = idOf(resultOf(first).run)
    const runs = h.db.listRuns()
    const replay = await h.dispatch(
      orchestrationRequest('orchestration.runCreate', params, options)
    )
    expect(replay).toMatchObject({
      ok: true,
      result: {
        run: { id: runId },
        mutation: { replayed: true }
      }
    })
    expect(h.db.listRuns()).toEqual(runs)
  })
})
