import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import {
  ADDRESS_X,
  ADDRESS_Y,
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  PROVIDER_ID_X,
  resultOf,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

describe('orchestration.callerShow: a session learns its Orca session ID from the host', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  function callerShow(options: Parameters<typeof orchestrationRequest>[2]) {
    return orchestrationRequest('orchestration.callerShow', {}, options)
  }

  it('answers a chat with its Orca session ID, even in terminal view where it also carries a pane', async () => {
    const response = await h.dispatch(
      callerShow({
        sessionId: SESSION_X,
        evidence: { terminalHandle: 'term_tui', paneKey: 'tab_tui:1:2' }
      })
    )

    expect(resultOf(response)).toEqual({
      caller: { orcaSessionId: ADDRESS_X, live: true }
    })
  })

  it('answers a structured worker with the Orca session ID its preamble names, whose mail is keyed by its handle', async () => {
    const handle = mintStructuredWorkerHandle()
    structuredWorkerIdentities.register({
      handle,
      sessionId: SESSION_Y,
      agent: 'claude',
      paneKey: mintStructuredWorkerPaneKey(SESSION_Y),
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const asX = (method: string, params: Record<string, unknown>) =>
      h.dispatch(orchestrationRequest(method, params, { sessionId: SESSION_X }))
    const runId = idOf(resultOf(await asX('orchestration.runCreate', { objective: 'o' })).run)
    const task = h.db.createTask({ runId, spec: 'work' })

    const shown = resultOf(
      await h.dispatch(callerShow({ sessionId: SESSION_Y, evidence: { terminalHandle: handle } }))
    )
    const { preamble } = resultOf(
      await asX('orchestration.dispatch', { task: task.id, to: ADDRESS_Y, dryRun: true })
    )
    await h.dispatch(
      orchestrationRequest(
        'orchestration.send',
        { to: ADDRESS_X, subject: 'progress', type: 'status' },
        { sessionId: SESSION_Y }
      )
    )
    const checked = resultOf(await asX('orchestration.check', { all: true, format: true }))

    expect(shown).toEqual({ caller: { orcaSessionId: ADDRESS_Y, live: true } })
    expect(preamble).toContain(`Your coordinator's Orca session ID is: ${ADDRESS_X}\n`)
    expect(preamble).toContain(`Your Orca session ID is: ${ADDRESS_Y}\n`)
    expect(preamble).not.toContain(handle)
    // Storage is unchanged: the mail it sends as either spelling is keyed by its minted handle.
    expect(checked.messages).toEqual([expect.objectContaining({ from_handle: handle })])
  })

  it('refuses a session that is not running, with the same code every orchestration verb gets', async () => {
    h.records.set(SESSION_X, sessionRecord(SESSION_X, { lease: { claimStatus: 'released' } }))

    const response = await h.dispatch(callerShow({ sessionId: SESSION_X }))

    expect(response).toMatchObject({
      ok: false,
      error: { code: CODES.notLive, message: expect.stringContaining(SESSION_X) }
    })
  })

  it("names the Orca id when handed the provider's id", async () => {
    const response = await h.dispatch(callerShow({ sessionId: PROVIDER_ID_X }))

    expect(response).toMatchObject({
      ok: false,
      error: { code: CODES.providerId, data: { orcaSessionId: SESSION_X } }
    })
  })

  it('refuses a session claim from a paired client, naming the host boundary', async () => {
    const response = await h.dispatchStreaming(callerShow({ sessionId: SESSION_X }), 'paired-1')

    expect(response).toMatchObject({ ok: false, error: { code: CODES.hostBoundary } })
  })

  it('answers null for a terminal agent, whose status stays as it was', async () => {
    const response = await h.dispatch(
      callerShow({ evidence: { terminalHandle: 'term_live', paneKey: 'tab_1:leaf_1' } })
    )

    expect(resultOf(response)).toEqual({ caller: null })
  })

  it('keeps the menu and caller address on the same conversation after clear', async () => {
    h.records.set(SESSION_X, {
      ...sessionRecord(SESSION_X),
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        operationId: 'same-conversation-clear',
        callerKey: 'caller',
        phase: 'committed'
      }
    })
    const shown = resultOf(
      await h.dispatch(
        orchestrationRequest('orchestration.sessionAddress', { sessionId: SESSION_X })
      )
    )
    const acting = resultOf(await h.dispatch(callerShow({ sessionId: SESSION_X })))
    expect(shown.orcaSessionId).toBe(ADDRESS_X)
    expect(acting.caller).toMatchObject({ orcaSessionId: ADDRESS_X })
  })

  it('gives each conversation its own menu and caller address beside an older clear pointer', async () => {
    const cleared = sessionRecord(SESSION_X)
    h.records.set(SESSION_X, {
      ...cleared,
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        replacementSessionId: SESSION_Y,
        operationId: 'op',
        callerKey: 'caller',
        phase: 'committed'
      }
    })

    for (const [sessionId, address] of [
      [SESSION_X, ADDRESS_X],
      [SESSION_Y, ADDRESS_Y]
    ] as const) {
      const shown = resultOf(
        await h.dispatch(orchestrationRequest('orchestration.sessionAddress', { sessionId }))
      )
      const acting = resultOf(await h.dispatch(callerShow({ sessionId })))
      expect(shown.orcaSessionId).toBe(address)
      expect(acting.caller).toMatchObject({ orcaSessionId: shown.orcaSessionId })
    }
  })

  it('refuses an id that is not an Orca session ID', async () => {
    const response = await h.dispatch(
      orchestrationRequest('orchestration.sessionAddress', { sessionId: 'not an id' })
    )

    expect(response).toMatchObject({ ok: false, error: { code: CODES.unknown } })
  })

  it('answers null for a caller whose environment carries no identity', async () => {
    const response = await h.dispatch(callerShow({}))

    expect(resultOf(response)).toEqual({ caller: null })
  })
})
