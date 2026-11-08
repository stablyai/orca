import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { ORCHESTRATION_SESSION_CALLER_ERROR_CODES as CODES } from '../../../shared/orchestration-session-caller-codes'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  ADDRESS_X,
  ADDRESS_Y,
  createSessionCallerHarness,
  idOf,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  WORKER_HANDLE,
  WORKER_PANE,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

type Row = Record<string, unknown>

const SESSION_Z = testOrcaSessionId('3f9a1c7e-6b2d-4e85-a0c4-9d1e7b3f5a26')
const ADDRESS_Z = formatOrcaSessionAddress(SESSION_Z)

/** Worker Y's two spellings; a chat has only its session address. */
const handle = mintStructuredWorkerHandle()
const paneKey = mintStructuredWorkerPaneKey(SESSION_Y)
const WORKER_SPELLINGS = [
  ['its handle', handle],
  ['its session address', ADDRESS_Y]
] as const

let h: SessionCallerHarness

beforeEach(() => {
  h = createSessionCallerHarness(hostRef)
  h.records.set(SESSION_Z, sessionRecord(SESSION_Z))
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

function call(sessionId: string | undefined, method: string, params: Row) {
  return h.dispatch(orchestrationRequest(method, params, { sessionId }))
}

async function as(sessionId: string | undefined, method: string, params: Row): Promise<Row> {
  return resultOf(await call(sessionId, method, params))
}

function chatRun(sessionId = SESSION_X): Promise<string> {
  return as(sessionId, 'orchestration.runCreate', { objective: 'o' }).then(({ run }) => idOf(run))
}

/** Worker Y assigned a Dispatch in `runId`, as `worker-start` leaves it. */
function assignWorker(runId: string): string {
  return h.db.createDispatchContext({
    taskId: h.db.createTask({ runId, spec: 'work' }).id,
    assigneeHandle: handle,
    assigneePaneKey: paneKey,
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
    creator: { kind: 'session', orcaSessionId: SESSION_X },
    maxDepth: Number.MAX_SAFE_INTEGER
  }).id
}

/** The PTY terminal assigned a Dispatch in a Run, so it may ask that Run's coordinator. */
function assignTerminal(runId: string): void {
  h.db.createDispatchContext({
    taskId: h.db.createTask({ runId, spec: 'sub' }).id,
    assigneeHandle: WORKER_HANDLE,
    assigneePaneKey: WORKER_PANE,
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER
  })
}

describe('every target param resolves both spellings of a party to one canonical address', () => {
  it.each(WORKER_SPELLINGS)(
    'dispatch: a worker named by %s is the assignee, and its check reads the Dispatch',
    async (_l, to) => {
      const runId = await chatRun()
      const task = h.db.createTask({ runId, spec: 'work' })

      const { dispatch } = await as(SESSION_X, 'orchestration.dispatch', { task: task.id, to })

      expect(dispatch).toMatchObject({
        assignee_handle: handle,
        assignee_orca_session_id: SESSION_Y
      })
      expect(await as(SESSION_Y, 'orchestration.check', { peek: true })).toMatchObject({
        dispatchId: idOf(dispatch)
      })
    }
  )

  it('dispatch: a chat named by its session address is the assignee, by its Orca session ID', async () => {
    const runId = await chatRun()
    const task = h.db.createTask({ runId, spec: 'work' })

    const { dispatch } = await as(SESSION_X, 'orchestration.dispatch', {
      task: task.id,
      to: ADDRESS_Z
    })

    expect(dispatch).toMatchObject({
      assignee_handle: ADDRESS_Z,
      assignee_orca_session_id: SESSION_Z,
      assignee_pane_key: null,
      process_incarnation: null
    })
    expect(await as(SESSION_Z, 'orchestration.check', { peek: true })).toMatchObject({
      dispatchId: idOf(dispatch)
    })
  })

  it('dispatch: refuses a chat on another host with no row written', async () => {
    const runId = await chatRun()
    const task = h.db.createTask({ runId, spec: 'work' })
    h.records.set(SESSION_Z, sessionRecord(SESSION_Z, { location: { executionHostId: 'ssh:box' } }))

    const response = await call(SESSION_X, 'orchestration.dispatch', {
      task: task.id,
      to: ADDRESS_Z
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: CODES.hostBoundary, data: { effectsApplied: false } }
    })
    expect(h.db.db.prepare('SELECT COUNT(*) AS n FROM dispatch_contexts').get()).toEqual({ n: 0 })
    expect(h.db.getTask(task.id)?.status).toBe('ready')
  })
})

describe('a caller declared by a session address, on a request with no session id', () => {
  it("refuses a chat's session address, with no effects", async () => {
    const response = await call(undefined, 'orchestration.send', {
      from: ADDRESS_Z,
      to: WORKER_HANDLE,
      subject: 's'
    })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: CODES.chatNotDeclarable,
        message: expect.stringContaining(`Agent session ${SESSION_Z} is a chat`),
        data: { effectsApplied: false }
      }
    })
    expect(h.db.getInbox()).toEqual([])
  })
})

describe('a structured worker that coordinates a child Run while assigned in its parent', () => {
  it.each(WORKER_SPELLINGS)(
    'gets mail at %s in the child Run it reads, even with no live pane',
    async (_l, to) => {
      assignWorker(await chatRun())
      const childRun = idOf(
        (await as(SESSION_Y, 'orchestration.runCreate', { objective: 'c' })).run
      )
      // The harness answers no live pane for a structured handle, as for an evicted session.
      expect(h.runtime.getLiveTerminalPaneKey(handle)).toBeNull()

      for (const sender of [SESSION_X, undefined]) {
        const { message } = await as(sender, 'orchestration.send', {
          ...(sender ? {} : { from: WORKER_HANDLE }),
          to,
          subject: `from ${sender ?? 'terminal'}`
        })
        expect(message).toMatchObject({ to_handle: `run:${childRun}` })
      }
      expect(await as(SESSION_Y, 'orchestration.check', { peek: true })).toMatchObject({
        runId: childRun,
        count: 2
      })
    }
  )
})

describe('no writer stores a structured worker under its session address', () => {
  it('keeps every to_handle and from_handle at the canonical address across every mail writer', async () => {
    const runId = await chatRun()
    const task = h.db.createTask({ runId, spec: 'work' })
    await as(SESSION_X, 'orchestration.dispatch', { task: task.id, to: ADDRESS_Y })
    assignTerminal(runId)

    for (const to of [ADDRESS_Y, handle]) {
      await as(SESSION_X, 'orchestration.send', { to, subject: 'down' })
    }
    const fromWorker = await as(SESSION_Y, 'orchestration.send', {
      from: ADDRESS_Y,
      to: ADDRESS_X,
      subject: 'up'
    })
    await as(undefined, 'orchestration.send', { from: ADDRESS_Y, to: WORKER_HANDLE, subject: 'u' })
    await as(SESSION_X, 'orchestration.reply', {
      id: idOf(fromWorker.message),
      body: 'noted'
    })
    await as(SESSION_X, 'orchestration.send', { to: '@all', subject: 'everyone' })
    await as(undefined, 'orchestration.ask', {
      from: WORKER_HANDLE,
      to: ADDRESS_X,
      question: 'q',
      timeoutMs: 0
    })

    const stored = h.db.db
      .prepare(
        `SELECT m.id FROM messages AS m JOIN dispatch_contexts AS d
           ON d.assignee_orca_session_id IS NOT NULL
          AND 'orca_session_id:' || d.assignee_orca_session_id IN (m.to_handle, m.from_handle)`
      )
      .all()
    expect(h.db.getInbox(100).length).toBeGreaterThanOrEqual(7)
    expect(stored).toEqual([])
  })
})
