import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  orchestrationRequest,
  idOf,
  resultOf,
  SESSION_X,
  SESSION_Y,
  WORKER_HANDLE,
  WORKER_PANE,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
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
    expect(outbound).toMatchObject({
      from_handle: ADDRESS_X,
      to_handle: `dispatch:${idOf(dispatch)}`,
      run_id: runId
    })

    const replied = await as(SESSION_X, 'orchestration.reply', {
      id: idOf(inbound),
      body: 'ack'
    })
    expect(replied).toMatchObject({
      message: {
        from_handle: ADDRESS_X,
        to_handle: `dispatch:${idOf(dispatch)}`,
        run_id: runId,
        thread_id: idOf(inbound)
      }
    })
    expect(await as(undefined, 'orchestration.check', { terminal: WORKER_HANDLE })).toMatchObject({
      runId,
      dispatchId: idOf(dispatch),
      count: 2,
      messages: [{ id: idOf(outbound) }, { id: idOf(replied.message) }]
    })

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
    const deliver = vi.spyOn(h.db, 'getOrCreateRunDelivery')
    const acknowledge = vi.spyOn(h.db, 'acknowledgeRunDelivery')

    await as(SESSION_Y, 'orchestration.runUse', { id: runId })

    const fenced = await waiting
    expect(fenced).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(fenced).not.toHaveProperty('result')

    const { message } = await as(undefined, 'orchestration.send', {
      from: WORKER_HANDLE,
      to: ADDRESS_Y,
      subject: 'after takeover',
      run: runId
    })
    expect(
      await h.dispatch(
        orchestrationRequest('orchestration.check', { run: runId }, { sessionId: SESSION_X })
      )
    ).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(deliver).not.toHaveBeenCalled()

    const replacement = await as(SESSION_Y, 'orchestration.check', {})
    expect(replacement).toMatchObject({
      runId,
      count: 1,
      messages: [{ id: idOf(message), to_handle: `run:${runId}`, run_id: runId }]
    })
    const ack = replacement.deliveryId
    if (typeof ack !== 'string') {
      throw new Error('Expected a Run Delivery')
    }
    expect(
      await h.dispatch(
        orchestrationRequest('orchestration.check', { run: runId, ack }, { sessionId: SESSION_X })
      )
    ).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
    expect(acknowledge).not.toHaveBeenCalled()
    expect(await as(SESSION_Y, 'orchestration.check', {})).toMatchObject({
      deliveryId: null,
      count: 0
    })
    expect(await as(SESSION_Y, 'orchestration.check', { ack })).toMatchObject({
      acknowledged: ack,
      count: 0
    })
    expect(h.db.getDeliveryRaw(ack)?.status).toBe('acknowledged')
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

  it('cannot take or read the Run it works for after making a sub-Run, and keeps its mail', async () => {
    // The 10-14 incident: a worker made a sub-Run, `check --run <parent>` said "bound to X, not Y",
    // and it ran run-use on the parent, unbinding its coordinator.
    const { runId } = dispatchToWorker()
    const as = (method: string, params: Row) =>
      h.dispatch(orchestrationRequest(method, params, { sessionId: workerSession }))
    resultOf(await as('orchestration.runCreate', { objective: 'sub' }))

    const read = await as('orchestration.check', { run: runId, peek: true })
    expect(read).toMatchObject({ ok: false, error: { code: 'worker_cannot_coordinate_own_run' } })
    expect(JSON.stringify(read)).not.toContain('run-use')
    expect(resultOf(await as('orchestration.check', { peek: true }))).toMatchObject({
      messages: [{ subject: 'instructions' }]
    })

    expect(await as('orchestration.runUse', { id: runId })).toMatchObject({
      ok: false,
      error: { code: 'worker_cannot_coordinate_own_run', data: { effectsApplied: false } }
    })
    expect(h.db.getRunRaw(runId)).toMatchObject({
      coordinator_handle: 'term_coord',
      consumer_generation: 1
    })
  })
})
