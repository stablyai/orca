import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import {
  ACTOR_X,
  createSessionCallerHarness,
  idOf,
  isRecord,
  orchestrationRequest,
  resultOf,
  PROVIDER_ID_X,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

type Row = Record<string, unknown>

describe('a send addressed to an agent session', () => {
  let h: SessionCallerHarness
  let visible: string[]

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
    visible = [SESSION_X, SESSION_Y]
    hostRef.current = {
      deps: {
        store: {
          getRecord: (sessionId: string) => h.records.get(sessionId) ?? null,
          listRecords: () => [...h.records.values()],
          getVisibleSessionTabIndex: () => ({ present: true, sessionIds: visible })
        }
      }
    }
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  async function send(to: string): Promise<Row> {
    const response: unknown = await h.dispatch(
      orchestrationRequest('orchestration.send', { from: 'term_worker', to, subject: 'hello' })
    )
    if (!isRecord(response)) {
      throw new Error('expected an RPC response object')
    }
    return response
  }

  function errorMessage(response: Row): string {
    return isRecord(response.error) ? String(response.error.message) : ''
  }

  it('stores mail to a live session that coordinates nothing at its own address, and points it', async () => {
    // The refusal this replaces: "Terminal session:<id> has no live pane or durable Run/Dispatch
    // mailbox." An agent's id is its public address, coordinator or not.
    const deliver = vi.spyOn(h.runtime, 'deliverPendingMessagesForHandle')
    const sent = await send(ACTOR_X)
    expect(sent).toMatchObject({ ok: true, result: { message: { to_handle: ACTOR_X } } })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith(ACTOR_X, expect.anything()))
  })

  it('accepts a bare Orca session id and normalizes it', async () => {
    expect(await send(SESSION_X)).toMatchObject({
      ok: true,
      result: { message: { to_handle: ACTOR_X } }
    })
  })

  it('keeps routing a coordinating session to its Run mailbox', async () => {
    const created = await h.dispatch(
      orchestrationRequest('orchestration.runCreate', { objective: 'o' }, { sessionId: SESSION_X })
    )
    const runId = idOf(resultOf(created).run)
    expect(await send(ACTOR_X)).toMatchObject({
      ok: true,
      result: { message: { to_handle: `run:${runId}` } }
    })
  })

  it.each([
    [
      'an unknown session',
      () => `session:0b0b0b0b-1111-4222-8333-444444444444`,
      'session_caller_unknown'
    ],
    ['a malformed session address', () => 'session:term_abc', 'session_caller_unknown'],
    ['a provider id', () => `session:${PROVIDER_ID_X}`, 'session_caller_provider_id'],
    ['a bare provider id', () => PROVIDER_ID_X, 'session_caller_provider_id']
  ])('refuses %s before storing anything', async (_label, to, code) => {
    const sent = await send(to())
    expect(sent).toMatchObject({ ok: false, error: { code } })
    expect(h.db.getInbox(100)).toEqual([])
  })

  it('refuses a session on another host', async () => {
    h.records.set(SESSION_Y, sessionRecord(SESSION_Y, { location: { executionHostId: 'ssh:box' } }))
    expect(await send(`session:${SESSION_Y}`)).toMatchObject({
      ok: false,
      error: { code: 'session_caller_host_boundary' }
    })
    expect(h.db.getInbox(100)).toEqual([])
  })

  it('refuses a session whose chat was closed, naming why', async () => {
    visible = [SESSION_X]
    const sent = await send(`session:${SESSION_Y}`)
    expect(sent).toMatchObject({ ok: false, error: { code: 'session_caller_not_live' } })
    expect(errorMessage(sent)).toContain('its chat was closed')
    expect(h.db.getInbox(100)).toEqual([])
  })

  it('refuses a structured worker whose worker identity is gone: nothing could ever read it', async () => {
    // A Dispatch recorded the session as a worker; no registry entry or custody row maps it now.
    const run = h.db.createRun({
      objective: 'pty',
      coordinatorHandle: 'term_c',
      coordinatorPaneKey: 'tab_c:13131313-1313-4313-8313-131313131313'
    })
    h.db.createDispatchContext({
      taskId: h.db.createTask({ runId: run.id, spec: 'work' }).id,
      assigneeHandle: mintStructuredWorkerHandle(),
      assigneePaneKey: mintStructuredWorkerPaneKey(SESSION_Y),
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    structuredWorkerIdentities.clear()
    const sent = await send(`session:${SESSION_Y}`)
    expect(sent).toMatchObject({ ok: false, error: { code: 'session_caller_not_live' } })
    expect(errorMessage(sent)).toContain('worker identity')
  })

  it('leaves a bare string that is no session a terminal handle, as before', async () => {
    expect(await send('0b0b0b0b-1111-4222-8333-444444444444')).toMatchObject({
      ok: false,
      error: { code: 'terminal_not_found' }
    })
  })
})

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

  it('lands in its Dispatch mailbox, which its flagless check reads', async () => {
    // The defect this pins: the mail was stored at `session:<id>`, pointed at the worker, and its
    // `check` — which reads the worker's handle and Dispatch mailboxes — returned nothing.
    const run = h.db.createRun({
      objective: 'pty coordinator',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:12121212-1212-4212-8212-121212121212'
    })
    const dispatch = h.db.createDispatchContext({
      taskId: h.db.createTask({ runId: run.id, spec: 'work' }).id,
      assigneeHandle: handle,
      assigneePaneKey: paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    expect(await sendTo(`session:${SESSION_Y}`)).toMatchObject({
      message: { to_handle: `dispatch:${dispatch.id}` }
    })
    expect(await flaglessCheck()).toMatchObject({ messages: [{ subject: 'hello' }] })
  })

  it('lands in its own handle mailbox between Dispatches, which its flagless check reads', async () => {
    expect(await sendTo(SESSION_Y)).toMatchObject({ message: { to_handle: handle } })
    expect(await flaglessCheck()).toMatchObject({ messages: [{ subject: 'hello' }] })
  })
})
