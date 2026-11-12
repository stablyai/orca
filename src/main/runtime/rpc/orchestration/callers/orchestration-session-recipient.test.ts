import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  ADDRESS_X,
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  SESSION_Y,
  WORKER_HANDLE,
  type SessionCallerHarness
} from './session.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)

type Row = Record<string, unknown>

describe('a live structured worker addressed by its session id', () => {
  let h: SessionCallerHarness
  const handle = mintStructuredWorkerHandle()
  const paneKey = mintStructuredWorkerPaneKey(SESSION_Y)

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
    structuredWorkerIdentities.register({
      handle,
      sessionId: SESSION_Y,
      agent: 'claude',
      paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  async function sendTo(to: string): Promise<Row> {
    return resultOf(
      await h.dispatch(
        orchestrationRequest('orchestration.send', { from: 'term_worker', to, subject: 'hello' })
      )
    )
  }

  async function flaglessCheck(): Promise<Row> {
    return resultOf(
      await h.dispatch(
        orchestrationRequest('orchestration.check', { peek: true }, { sessionId: SESSION_Y })
      )
    )
  }

  it('lands in its own handle mailbox between Dispatches, which its flagless check reads', async () => {
    expect(await sendTo(SESSION_Y)).toMatchObject({ message: { to_handle: handle } })
    expect(await flaglessCheck()).toMatchObject({ messages: [{ subject: 'hello' }] })
  })
})

describe('mail sent to a session address reaches the mailbox that session reads', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  async function as(sessionId: string | undefined, method: string, params: Row): Promise<Row> {
    return resultOf(await h.dispatch(orchestrationRequest(method, params, { sessionId })))
  }

  function sendFromTerminal(to: string): Promise<Row> {
    return as(undefined, 'orchestration.send', { from: WORKER_HANDLE, to, subject: 'hello' })
  }

  it("files it under the chat's current Run, as a terminal coordinator's pane does", async () => {
    await as(SESSION_X, 'orchestration.runCreate', { objective: 'first' })
    const current = idOf(
      (await as(SESSION_X, 'orchestration.runCreate', { objective: 'next' })).run
    )

    const { message } = await sendFromTerminal(ADDRESS_X)

    expect(message).toMatchObject({ to_handle: `run:${current}`, run_id: current })
    expect(await as(SESSION_X, 'orchestration.check', {})).toMatchObject({
      runId: current,
      messages: [{ subject: 'hello' }]
    })
  })

  it('delivers it to a chat with no Run, which reads its direct mailbox', async () => {
    const { message } = await sendFromTerminal(ADDRESS_X)

    expect(message).toMatchObject({ to_handle: ADDRESS_X })
    expect(await as(SESSION_X, 'orchestration.check', {})).toMatchObject({
      messages: [{ subject: 'hello' }]
    })
  })

  it('reaches a chat with no Run after a restart, once the send has started the session host', async () => {
    // After restart, start the lazy session host before synchronous recipient-record lookup.
    const store = hostRef.current
    hostRef.current = null
    vi.mocked(h.runtime.ensureStructuredAgentSessionHost).mockImplementation(async () => {
      hostRef.current = store
    })

    const { message } = await sendFromTerminal(ADDRESS_X)

    expect(message).toMatchObject({ to_handle: ADDRESS_X })
  })
})
