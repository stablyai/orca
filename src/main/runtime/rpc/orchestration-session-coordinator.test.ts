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
  WORKER_HANDLE,
  WORKER_PANE,
  WORKSPACE_X,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

type Row = Record<string, unknown>

describe('a structured chat coordinates through the same verbs as a terminal', () => {
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

  async function runCreate(sessionId: string, objective = 'o'): Promise<string> {
    const { run } = await as(sessionId, 'orchestration.runCreate', { objective })
    return idOf(run)
  }

  it('runs the supervised loop: run, task, dispatch, worker mail in, check, send, reply, gates', async () => {
    const runId = await runCreate(SESSION_X)
    expect(h.db.getRunRaw(runId)).toMatchObject({
      coordinator_handle: null,
      coordinator_pane_key: null,
      coordinator_orca_session_id: SESSION_X
    })
    expect(await as(SESSION_X, 'orchestration.runCurrent', {})).toMatchObject({
      run: { id: runId }
    })

    const { task } = await as(SESSION_X, 'orchestration.taskCreate', { spec: 'do it' })
    const taskId = idOf(task)
    expect(task).toMatchObject({ run_id: runId, created_by_terminal_handle: null })
    expect(await as(SESSION_X, 'orchestration.taskList', {})).toMatchObject({ runId, count: 1 })

    const { dispatch } = await as(SESSION_X, 'orchestration.dispatch', {
      task: taskId,
      to: WORKER_HANDLE
    })
    expect(dispatch).toMatchObject({
      assignee_handle: WORKER_HANDLE,
      creator_handle: null,
      creator_pane_key: null,
      creator_orca_session_id: SESSION_X,
      depth: 1
    })

    // The worker writes to its coordinator's public address.
    const { message: inbound } = await as(undefined, 'orchestration.send', {
      from: WORKER_HANDLE,
      to: ADDRESS_X,
      subject: 'progress'
    })
    expect(inbound).toMatchObject({ to_handle: `run:${runId}`, run_id: runId })

    const checked = await as(SESSION_X, 'orchestration.check', {})
    expect(checked).toMatchObject({ runId, count: 1, messages: [{ subject: 'progress' }] })

    const { message: outbound } = await as(SESSION_X, 'orchestration.send', {
      to: WORKER_HANDLE,
      subject: 'more'
    })
    expect(outbound).toMatchObject({ from_handle: ADDRESS_X, run_id: runId })

    const replied = await as(SESSION_X, 'orchestration.reply', {
      id: idOf(inbound),
      body: 'ack'
    })
    expect(replied).toMatchObject({ message: { from_handle: ADDRESS_X, to_handle: WORKER_HANDLE } })

    const { gate } = await as(SESSION_X, 'orchestration.gateCreate', {
      task: taskId,
      question: 'ship?'
    })
    expect(await as(SESSION_X, 'orchestration.gateList', {})).toMatchObject({ runId, count: 1 })
    expect(
      await as(SESSION_X, 'orchestration.gateResolve', {
        id: idOf(gate),
        resolution: 'yes'
      })
    ).toMatchObject({ gate: { status: 'resolved' } })

    expect(
      await as(SESSION_X, 'orchestration.taskUpdate', { id: taskId, status: 'completed' })
    ).toMatchObject({ task: { status: 'completed' } })
  })

  it("files a session's mail to a plain terminal under its own Run", async () => {
    const runId = await runCreate(SESSION_X)
    const { message } = await as(SESSION_X, 'orchestration.send', {
      to: WORKER_HANDLE,
      subject: 'no dispatch here'
    })
    expect(message).toMatchObject({
      from_handle: ADDRESS_X,
      to_handle: WORKER_HANDLE,
      run_id: runId
    })
  })

  it("addresses a group to the session's own Run", async () => {
    await runCreate(SESSION_X)
    const response = await h.dispatch(
      orchestrationRequest(
        'orchestration.send',
        { to: '@all', subject: 'everyone' },
        {
          sessionId: SESSION_X
        }
      )
    )
    // The audience resolved to the session's Run; that Run simply has no workers yet.
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'terminal_not_found',
        message: 'No recipients resolved for group address: @all'
      }
    })
  })

  it('asks as a coordinator does: only a supervised worker may ask', async () => {
    await runCreate(SESSION_X)
    const response = await h.dispatch(
      orchestrationRequest(
        'orchestration.ask',
        { question: 'q', to: WORKER_HANDLE },
        {
          sessionId: SESSION_X
        }
      )
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'dispatch_inactive' } })
  })

  it("lets its worker ask it at its session address, the one the worker's preamble names", async () => {
    const runId = await runCreate(SESSION_X)
    const taskId = idOf((await as(SESSION_X, 'orchestration.taskCreate', { spec: 'q' })).task)
    await as(SESSION_X, 'orchestration.dispatch', { task: taskId, to: WORKER_HANDLE })

    const asked = await as(undefined, 'orchestration.ask', {
      from: WORKER_HANDLE,
      to: ADDRESS_X,
      question: 'which way?',
      timeoutMs: 0
    })
    expect(asked).toMatchObject({ timedOut: true })
    expect(h.db.getQuestion(String(asked.messageId))).toMatchObject({ run_id: runId })
  })

  it("places a worker-start in the session's own workspace", async () => {
    const runId = await runCreate(SESSION_X)
    vi.spyOn(h.runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    const placed = vi
      .spyOn(h.runtime, 'showManagedTerminalWorkspace')
      .mockRejectedValue(new Error('placement reached'))
    const response = await h.dispatch(
      orchestrationRequest(
        'orchestration.workerStart',
        { spec: 'work', run: runId, agent: 'claude' },
        {
          sessionId: SESSION_X
        }
      )
    )
    expect(placed).toHaveBeenCalledWith(`id:${WORKSPACE_X}`)
    expect(response).toMatchObject({ ok: false, error: { message: 'placement reached' } })
  })

  it("never lets one chat's run-create unbind another chat's Run", async () => {
    const xFirst = await runCreate(SESSION_X, 'x first')
    const yRun = await runCreate(SESSION_Y, 'y')
    const xSecond = await runCreate(SESSION_X, 'x second')

    expect(await as(SESSION_Y, 'orchestration.runCurrent', {})).toMatchObject({
      run: { id: yRun }
    })
    expect(await as(SESSION_X, 'orchestration.runCurrent', {})).toMatchObject({
      run: { id: xSecond }
    })
    expect(h.db.getRunRaw(xFirst)?.coordinator_orca_session_id).toBeNull()
  })

  it('takes over a bound Run like a terminal does, and fences the previous coordinator', async () => {
    const runId = await runCreate(SESSION_X)
    await as(undefined, 'orchestration.send', {
      from: WORKER_HANDLE,
      to: ADDRESS_X,
      subject: 'before takeover',
      run: runId
    })

    expect(await as(SESSION_Y, 'orchestration.runUse', { id: runId })).toMatchObject({
      run: { id: runId }
    })

    const previous = await h.dispatch(
      orchestrationRequest('orchestration.check', { run: runId }, { sessionId: SESSION_X })
    )
    expect(previous).toMatchObject({
      ok: false,
      error: {
        code: 'consumer_fenced',
        message: `This coordinator terminal is no longer bound to Run ${runId}.`
      }
    })
    expect(await as(SESSION_X, 'orchestration.runCurrent', {})).toMatchObject({ run: null })
    expect(await as(SESSION_Y, 'orchestration.check', {})).toMatchObject({
      runId,
      messages: [{ subject: 'before takeover' }]
    })
  })

  it("wakes the previous coordinator's waiting check as fenced when another session takes over", async () => {
    const runId = await runCreate(SESSION_X)
    const waiter = vi.spyOn(h.runtime, 'waitForMessage')
    const waiting = h.dispatch(
      orchestrationRequest(
        'orchestration.check',
        { run: runId, wait: true, timeoutMs: 5_000 },
        {
          sessionId: SESSION_X
        }
      )
    )
    await vi.waitFor(() => expect(waiter).toHaveBeenCalledWith(`run:${runId}`, expect.anything()))

    await as(SESSION_Y, 'orchestration.runUse', { id: runId })

    expect(await waiting).toMatchObject({
      ok: false,
      error: {
        code: 'consumer_fenced',
        message: 'This mailbox consumer was replaced while waiting.'
      }
    })
  })

  it('stops counting a coordinator Orca session id once an older binary rebinds the Run to a terminal', async () => {
    const runId = await runCreate(SESSION_X)
    // An older binary's bindRun rewrites handle and pane and bumps the generation, never the Orca session id.
    h.db.db
      .prepare(
        `UPDATE runs SET coordinator_handle = ?, coordinator_pane_key = ?,
           consumer_generation = consumer_generation + 1
         WHERE id = ?`
      )
      .run(WORKER_HANDLE, WORKER_PANE, runId)

    expect(await as(SESSION_X, 'orchestration.runCurrent', {})).toMatchObject({ run: null })
    expect(await as(undefined, 'orchestration.runCurrent', { from: WORKER_HANDLE })).toMatchObject({
      run: { id: runId }
    })
  })

  it('replays an idempotent retry from the same session and refuses it from another', async () => {
    const first = await h.dispatch(
      orchestrationRequest(
        'orchestration.runCreate',
        { objective: 'o' },
        {
          sessionId: SESSION_X,
          requestId: 'retry-1'
        }
      )
    )
    const retry = await h.dispatch(
      orchestrationRequest(
        'orchestration.runCreate',
        { objective: 'o' },
        {
          sessionId: SESSION_X,
          requestId: 'retry-1'
        }
      )
    )
    const other = await h.dispatch(
      orchestrationRequest(
        'orchestration.runCreate',
        { objective: 'o' },
        {
          sessionId: SESSION_Y,
          requestId: 'retry-1'
        }
      )
    )

    const firstRun = idOf(resultOf(first).run)
    expect(resultOf(retry)).toMatchObject({ run: { id: firstRun }, mutation: { replayed: true } })
    expect(other).toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
    expect(h.db.listRuns().runs.filter((run) => run.legacy === 0)).toHaveLength(1)
  })
})

describe('a session with no Run, and receipts that carry no caller param', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  it('reads its direct mailbox on a consuming check, as a terminal with a live pane does', async () => {
    h.db.insertMessage({ from: WORKER_HANDLE, to: ADDRESS_X, subject: 'direct', body: '' })

    const checked = resultOf(
      await h.dispatch(orchestrationRequest('orchestration.check', {}, { sessionId: SESSION_X }))
    )

    expect(checked).toMatchObject({ messages: [{ subject: 'direct', to_handle: ADDRESS_X }] })
  })

  it('binds a receipt to the session even when the method names no caller', async () => {
    const reset = (sessionId: string) =>
      h.dispatch(
        orchestrationRequest(
          'orchestration.reset',
          { messages: true },
          {
            sessionId,
            requestId: 'reset-1'
          }
        )
      )

    expect(await reset(SESSION_X)).toMatchObject({ ok: true })
    expect(await reset(SESSION_X)).toMatchObject({
      ok: true,
      result: { mutation: { replayed: true } }
    })
    expect(await reset(SESSION_Y)).toMatchObject({
      ok: false,
      error: { code: 'request_mismatch' }
    })
  })
})

describe('a structured worker that names itself by session id', () => {
  let h: SessionCallerHarness
  const workerSession = SESSION_Y
  const handle = mintStructuredWorkerHandle()
  const paneKey = mintStructuredWorkerPaneKey(workerSession)

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
    structuredWorkerIdentities.register({
      handle,
      sessionId: workerSession,
      agent: 'claude',
      paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(workerSession),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  function dispatchToWorker(): { runId: string; dispatchId: string } {
    const run = h.db.createRun({
      objective: 'pty coordinator',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:12121212-1212-4212-8212-121212121212'
    })
    const dispatch = h.db.createDispatchContext({
      taskId: h.db.createTask({ runId: run.id, spec: 'work' }).id,
      assigneeHandle: handle,
      assigneePaneKey: paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(workerSession),
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    h.db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatch.id}`,
      subject: 'instructions',
      body: '',
      runId: run.id
    })
    return { runId: run.id, dispatchId: dispatch.id }
  }

  it("reads its own Dispatch mailbox: the session id wins and maps to the worker's handle", async () => {
    const { dispatchId } = dispatchToWorker()
    expect(h.db.getDispatchContextById(dispatchId)?.assignee_orca_session_id).toBe(SESSION_Y)

    const bySession = resultOf(
      await h.dispatch(
        orchestrationRequest('orchestration.check', { peek: true }, { sessionId: workerSession })
      )
    )
    expect(bySession).toMatchObject({ messages: [{ subject: 'instructions' }] })

    const namedByHandle = resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.check',
          { peek: true, terminal: handle },
          {
            sessionId: workerSession
          }
        )
      )
    )
    expect(namedByHandle).toEqual(bySession)
  })

  it.each([
    ['its handle', handle],
    ['its session address', ADDRESS_Y],
    ['its bare session id', workerSession]
  ])('accepts itself declared as %s and binds by its handle', async (_label, declared) => {
    const { run } = resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { objective: 'declared', from: declared },
          { sessionId: workerSession }
        )
      )
    )
    expect(h.db.getRunRaw(idOf(run))).toMatchObject({
      coordinator_handle: handle,
      coordinator_orca_session_id: SESSION_Y
    })
  })

  it('sends mail at either of its spellings to its Dispatch once assigned in a Run it coordinated before', async () => {
    const { run } = resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { objective: 'o' },
          { sessionId: workerSession }
        )
      )
    )
    const runId = idOf(run)
    // A chat takes the Run over; the worker's addresses stay remembered as a former coordinator's.
    resultOf(
      await h.dispatch(
        orchestrationRequest('orchestration.runUse', { id: runId }, { sessionId: SESSION_X })
      )
    )
    expect(h.db.getRunMailboxOwnerIdsForHandle(ADDRESS_Y)).toEqual([runId])
    const dispatch = h.db.createDispatchContext({
      taskId: h.db.createTask({ runId, spec: 'work' }).id,
      assigneeHandle: handle,
      assigneePaneKey: paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(workerSession),
      creator: { kind: 'session', orcaSessionId: SESSION_X },
      maxDepth: Number.MAX_SAFE_INTEGER
    })

    // Both spellings name one party, so both land in the one mailbox it reads, not the Run's.
    for (const to of [ADDRESS_Y, handle]) {
      const { message } = resultOf(
        await h.dispatch(
          orchestrationRequest('orchestration.send', { to, subject: to }, { sessionId: SESSION_X })
        )
      )
      expect(message).toMatchObject({ to_handle: `dispatch:${dispatch.id}` })
    }
    const read = resultOf(
      await h.dispatch(
        orchestrationRequest('orchestration.check', { peek: true }, { sessionId: workerSession })
      )
    )
    expect(read).toMatchObject({
      count: 2,
      messages: expect.arrayContaining([
        expect.objectContaining({ subject: handle }),
        expect.objectContaining({ subject: ADDRESS_Y })
      ])
    })
  })

  it('coordinates with its handle, pane and Orca session id, one mailbox at both spellings', async () => {
    const { run } = resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { objective: 'nested' },
          {
            sessionId: workerSession
          }
        )
      )
    )
    const runId = idOf(run)

    expect(h.db.getRunRaw(runId)).toMatchObject({
      coordinator_handle: handle,
      coordinator_pane_key: paneKey,
      coordinator_orca_session_id: SESSION_Y
    })
    expect(h.db.getRunMailboxOwnerIdsForHandle(handle)).toEqual([runId])
    for (const to of [handle, ADDRESS_Y]) {
      const { message } = resultOf(
        await h.dispatch(
          orchestrationRequest('orchestration.send', { from: WORKER_HANDLE, to, subject: to })
        )
      )
      expect(message).toMatchObject({ to_handle: `run:${runId}` })
    }
  })

  it.each([
    ['its handle', handle],
    ['its session address', ADDRESS_Y]
  ])('is asked by its own worker at %s', async (_label, to) => {
    const { run } = resultOf(
      await h.dispatch(
        orchestrationRequest(
          'orchestration.runCreate',
          { objective: 'o' },
          { sessionId: workerSession }
        )
      )
    )
    const runId = idOf(run)
    h.db.createDispatchContext({
      taskId: h.db.createTask({ runId, spec: 'sub' }).id,
      assigneeHandle: WORKER_HANDLE,
      assigneePaneKey: WORKER_PANE,
      creator: { kind: 'terminal', handle, paneKey, orcaSessionId: workerSession },
      maxDepth: Number.MAX_SAFE_INTEGER
    })

    const asked = resultOf(
      await h.dispatch(
        orchestrationRequest('orchestration.ask', {
          from: WORKER_HANDLE,
          to,
          question: 'which way?',
          timeoutMs: 0
        })
      )
    )
    expect(asked).toMatchObject({ timedOut: true })
    expect(h.db.getQuestion(String(asked.messageId))).toMatchObject({ run_id: runId })
  })
})
