import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  orchestrationRequest,
  idOf,
  resultOf,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  WORKER_HANDLE,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

type Row = Record<string, unknown>

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

  it('refuses an Orca session this host does not run', async () => {
    h.records.set(
      SESSION_X,
      sessionRecord(SESSION_X, { location: { executionHostId: 'ssh:devbox' } })
    )
    h.records.delete(SESSION_Y)

    for (const to of [ADDRESS_X, ADDRESS_Y]) {
      const response = await h.dispatch(
        orchestrationRequest('orchestration.send', { from: WORKER_HANDLE, to, subject: 's' })
      )
      expect(response).toMatchObject({ ok: false, error: { code: 'terminal_not_found' } })
    }
  })

  it("routes a structured worker's session address to the Dispatch it is working", async () => {
    const handle = mintStructuredWorkerHandle()
    const paneKey = mintStructuredWorkerPaneKey(SESSION_Y)
    structuredWorkerIdentities.register({
      handle,
      sessionId: SESSION_Y,
      agent: 'claude',
      paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const runId = idOf((await as(SESSION_X, 'orchestration.runCreate', { objective: 'o' })).run)
    const dispatch = h.db.createDispatchContext({
      taskId: h.db.createTask({ runId, spec: 'work' }).id,
      assigneeHandle: handle,
      assigneePaneKey: paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      creator: { kind: 'session', orcaSessionId: SESSION_X },
      maxDepth: Number.MAX_SAFE_INTEGER
    })

    const { message } = await as(SESSION_X, 'orchestration.send', {
      to: ADDRESS_Y,
      subject: 'to the worker'
    })

    expect(message).toMatchObject({ to_handle: `dispatch:${dispatch.id}`, run_id: runId })
    expect(await as(SESSION_Y, 'orchestration.check', { peek: true })).toMatchObject({
      dispatchId: dispatch.id,
      messages: [{ subject: 'to the worker' }]
    })
  })
})
