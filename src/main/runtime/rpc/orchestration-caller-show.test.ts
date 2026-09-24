import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import {
  ACTOR_X,
  createSessionCallerHarness,
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

describe('orchestration.callerShow: the caller learns its own address from the host', () => {
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

  it('answers a chat with session:<id>, even in terminal view where it also carries a pane', async () => {
    const response = await h.dispatch(
      callerShow({
        sessionId: SESSION_X,
        evidence: { terminalHandle: 'term_tui', paneKey: 'tab_tui:1:2' }
      })
    )

    expect(resultOf(response)).toEqual({
      caller: { kind: 'session', address: ACTOR_X, sessionId: SESSION_X, live: true }
    })
  })

  it('answers a structured worker with its session address, not the handle it was minted', async () => {
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

    const response = await h.dispatch(
      callerShow({ sessionId: SESSION_Y, evidence: { terminalHandle: handle } })
    )

    expect(resultOf(response)).toEqual({
      caller: { kind: 'session', address: `session:${SESSION_Y}`, sessionId: SESSION_Y, live: true }
    })
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

  it('answers a terminal agent with the handle its environment carries, and whether it is live', async () => {
    const probe = vi
      .spyOn(h.runtime, 'resolveTerminalIdentity')
      .mockImplementation((handle) => ({ handle, live: handle === 'term_live' }))

    const live = await h.dispatch(callerShow({ evidence: { terminalHandle: 'term_live' } }))
    const stale = await h.dispatch(callerShow({ evidence: { terminalHandle: 'term_stale' } }))

    expect(resultOf(live)).toEqual({
      caller: { kind: 'terminal', address: 'term_live', live: true }
    })
    expect(resultOf(stale)).toEqual({
      caller: { kind: 'terminal', address: 'term_stale', live: false }
    })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('answers the reminted handle, as the coordinator verbs act, when the carried one went stale', async () => {
    vi.spyOn(h.runtime, 'resolveTerminalIdentity').mockImplementation((handle) => ({
      handle,
      live: handle === 'term_new'
    }))
    const resolvePane = vi.spyOn(h.runtime, 'resolveTerminalPane').mockImplementation((paneKey) => {
      if (paneKey !== 'tab_1:leaf_1') {
        throw new Error('terminal_not_found')
      }
      return { handle: 'term_new', tabId: 'tab_1', leafId: 'leaf_1', ptyId: null, connected: true }
    })

    const reminted = await h.dispatch(
      callerShow({ evidence: { terminalHandle: 'term_old', paneKey: 'tab_1:leaf_1' } })
    )
    const paneOnly = await h.dispatch(callerShow({ evidence: { paneKey: 'tab_1:leaf_1' } }))
    const gone = await h.dispatch(
      callerShow({ evidence: { terminalHandle: 'term_old', paneKey: 'tab_gone:leaf' } })
    )

    expect(resultOf(reminted)).toEqual({
      caller: { kind: 'terminal', address: 'term_new', live: true }
    })
    expect(resultOf(paneOnly)).toEqual({
      caller: { kind: 'terminal', address: 'term_new', live: true }
    })
    expect(resultOf(gone)).toEqual({
      caller: { kind: 'terminal', address: 'term_old', live: false }
    })
    expect(resolvePane).toHaveBeenCalledTimes(3)
  })

  it('answers null for a caller whose environment carries no identity', async () => {
    const response = await h.dispatch(callerShow({}))

    expect(resultOf(response)).toEqual({ caller: null })
  })
})
