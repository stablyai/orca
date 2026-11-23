import { afterEach, expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  ADDRESS_Y,
  createSessionCallerHarness,
  orchestrationRequest,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  WORKSPACE_X
} from './session.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)

const ORIGINAL_COORDINATOR = testOrcaSessionId('78f238aa-a3bd-41b2-bdcb-f5c116639701')
const FOREIGN_SESSION = testOrcaSessionId('22c070fd-91be-450f-8c92-1b04eeaeb703')
let h: ReturnType<typeof createSessionCallerHarness> | undefined

afterEach(() => h?.close())

it('refuses a closed worker as a target before assigning work or sending mail', async () => {
  const { db, dispatch, records, runtime } = (h = createSessionCallerHarness(hostRef, () => ({
    present: true,
    sessionIds: [SESSION_X]
  })))
  records.set(
    ORIGINAL_COORDINATOR,
    sessionRecord(ORIGINAL_COORDINATOR, { lease: { unreconciled: true } })
  )
  records.set(
    SESSION_Y,
    sessionRecord(SESSION_Y, {
      lease: {
        claimStatus: 'released',
        ownerProcess: null,
        reservedSpawnToken: null,
        deathEvidence: {
          kind: 'exit-observed',
          detail: 'observed exit',
          observedAt: 40_000,
          lastProvenAliveAt: 30_000,
          ownerFence: 7
        }
      }
    })
  )
  records.set(
    FOREIGN_SESSION,
    sessionRecord(FOREIGN_SESSION, { location: { wslDistro: 'Ubuntu' } })
  )
  const run = db.createRun({
    objective: 'Resume a stopped worker',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: ORIGINAL_COORDINATOR
  })
  const task = db.createTask({ spec: 'Continue the original task', runId: run.id })
  const { dispatch: stopped } = db.createStartingWorkerDispatch({
    creator: { kind: 'session', orcaSessionId: ORIGINAL_COORDINATOR },
    maxDepth: 4,
    taskId: task.id,
    startOptions: {},
    runtimeEpoch: runtime.getRuntimeId()
  })
  const handle = mintStructuredWorkerHandle()
  db.prepareStartingWorkerAuthority({
    dispatchId: stopped.id,
    handle,
    paneKey: mintStructuredWorkerPaneKey(SESSION_Y),
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
    worktreeId: WORKSPACE_X,
    effects: [],
    setupState: 'not_applicable',
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(stopped.id)
  db.beginWorkerStop(stopped.id, runtime.getRuntimeId())
  db.settleWorkerStop(stopped.id)
  const bind = await dispatch(
    orchestrationRequest('orchestration.runUse', { id: run.id }, { sessionId: SESSION_X })
  )
  expect(bind).toMatchObject({
    ok: true,
    result: {
      run: {
        id: run.id,
        coordinator_handle: null,
        consumer_generation: run.consumer_generation + 1
      }
    }
  })
  expect(db.getRun(run.id)?.coordinator_orca_session_id).toBe(SESSION_X)

  const ready = db.createTask({ spec: 'Assign a ready task', runId: run.id })
  const retry = { task: task.id, run: run.id, retryOf: stopped.id, terminal: handle }
  const start = (sessionId: string) =>
    dispatch(orchestrationRequest('orchestration.workerStart', retry, { sessionId }))
  const savedRun = db.getRun(run.id)
  const savedTask = db.getTask(task.id)
  const savedDispatch = db.getDispatchContext(task.id)
  const savedWorker = db.getWorkerDispatch(stopped.id)
  const savedResource = db.getWorkerTerminalResourceByHandle(handle)
  expect(savedWorker).toMatchObject({ state: 'stopped', stage: 'process_stopped' })
  expect(savedResource).toMatchObject({ owner_dispatch_id: stopped.id, ownership_state: 'owned' })

  const requestedChat = `The requested chat ${SESSION_Y} is closed.`
  const assignmentRefusal = {
    ok: false,
    error: {
      code: 'recipient_unreachable',
      message: `${requestedChat} No effects were applied.`,
      data: { effectsApplied: false }
    }
  }
  expect(await start(SESSION_X)).toMatchObject(assignmentRefusal)
  expect(
    await dispatch(
      orchestrationRequest(
        'orchestration.dispatch',
        { task: ready.id, run: run.id, to: ADDRESS_Y },
        { sessionId: SESSION_X }
      )
    )
  ).toMatchObject(assignmentRefusal)
  expect(
    await dispatch(
      orchestrationRequest(
        'orchestration.send',
        { to: ADDRESS_Y, run: run.id, subject: 'Synthetic mail' },
        { sessionId: SESSION_X }
      )
    )
  ).toMatchObject({
    ok: false,
    error: { code: 'recipient_unreachable', message: `${requestedChat} No message was sent.` }
  })

  expect(await start(ORIGINAL_COORDINATOR)).toMatchObject({
    ok: false,
    error: {
      code: 'session_caller_not_live',
      message: expect.stringContaining(ORIGINAL_COORDINATOR),
      data: { effectsApplied: false }
    }
  })
  expect(await start(FOREIGN_SESSION)).toMatchObject({
    ok: false,
    error: {
      code: 'session_caller_host_boundary',
      message: expect.stringContaining(FOREIGN_SESSION),
      data: { effectsApplied: false }
    }
  })
  expect(await start(SESSION_Y)).toMatchObject({ ok: false, error: { code: 'consumer_fenced' } })
  expect(db.getRun(run.id)).toEqual(savedRun)
  expect(db.getTask(task.id)).toEqual(savedTask)
  expect(db.getTask(ready.id)).toEqual(ready)
  expect(db.getDispatchContext(ready.id)).toBeUndefined()
  expect(db.getLatestUnreadMessageSequence(handle)).toBeUndefined()
  expect(db.getDispatchContext(task.id)).toEqual(savedDispatch)
  expect(db.getWorkerDispatch(stopped.id)).toEqual(savedWorker)
  expect(db.getWorkerTerminalResourceByHandle(handle)).toEqual(savedResource)
})

it('distinguishes an unverifiable chat successor from lost worker identity', async () => {
  const { db, dispatch, records, runtime } = (h = createSessionCallerHarness(hostRef))
  const missingSuccessor = testOrcaSessionId('320bb396-30d3-4593-870e-175cfdf0d1b1')
  const lostWorker = testOrcaSessionId('99d63fbd-357f-4fdc-9682-9dbb040e3e88')
  records.set(SESSION_Y, {
    ...sessionRecord(SESSION_Y),
    conversationCommand: {
      command: 'clear',
      state: 'completed',
      replacementSessionId: missingSuccessor,
      operationId: 'clear-task-chat',
      callerKey: 'caller',
      phase: 'committed'
    }
  })
  records.set(lostWorker, sessionRecord(lostWorker))
  const run = db.createRun({
    objective: 'Continue work',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: SESSION_X
  })
  const priorTask = db.createTask({ spec: 'Previous work', runId: run.id })
  const { dispatch: prior } = db.createStartingWorkerDispatch({
    creator: { kind: 'session', orcaSessionId: SESSION_X },
    maxDepth: 4,
    taskId: priorTask.id,
    startOptions: {},
    runtimeEpoch: runtime.getRuntimeId()
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: prior.id,
    handle: mintStructuredWorkerHandle(),
    paneKey: mintStructuredWorkerPaneKey(lostWorker),
    processIncarnation: structuredWorkerProcessIncarnation(lostWorker),
    worktreeId: WORKSPACE_X,
    effects: [],
    setupState: 'not_applicable'
  })
  const task = db.createTask({ spec: 'Assign new work', runId: run.id })
  const caller = { sessionId: SESSION_X }
  for (const [to, code, detail] of [
    [ADDRESS_Y, 'recipient_unreachable', missingSuccessor],
    [formatOrcaSessionAddress(lostWorker), 'session_caller_not_live', lostWorker]
  ] as const) {
    expect(
      await dispatch(
        orchestrationRequest('orchestration.dispatch', { task: task.id, run: run.id, to }, caller)
      )
    ).toMatchObject({
      ok: false,
      error: { code, message: expect.stringContaining(detail), data: { effectsApplied: false } }
    })
    expect(
      await dispatch(
        orchestrationRequest(
          'orchestration.send',
          { to, run: run.id, subject: 'Test mail' },
          caller
        )
      )
    ).toMatchObject({ ok: false, error: { code, message: expect.stringContaining(detail) } })
  }
  expect(db.getTask(task.id)).toEqual(task)
  expect(db.getDispatchContext(task.id)).toBeUndefined()
})
