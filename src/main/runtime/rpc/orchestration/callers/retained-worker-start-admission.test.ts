import { afterEach, expect, it, vi } from 'vitest'
import { testOrcaSessionId } from '../../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../../../orchestration/terminal-authority/structured-sessions/structured-worker-identity'
import {
  createSessionCallerHarness,
  orchestrationRequest,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  WORKSPACE_X
} from './session.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const ORIGINAL_COORDINATOR = testOrcaSessionId('78f238aa-a3bd-41b2-bdcb-f5c116639701')
const FOREIGN_SESSION = testOrcaSessionId('22c070fd-91be-450f-8c92-1b04eeaeb703')
let h: ReturnType<typeof createSessionCallerHarness> | undefined

afterEach(() => h?.close())

it('distinguishes a closed retained worker from a refused caller before changing the Task', async () => {
  const { db, dispatch, records, runtime } = (h = createSessionCallerHarness(hostRef, () => ({
    present: true,
    sessionIds: [SESSION_X]
  })))
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
  records.set(FOREIGN_SESSION, sessionRecord(FOREIGN_SESSION, { location: { wslDistro: 'Ubuntu' } }))
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

  const retry = { task: task.id, run: run.id, retryOf: stopped.id, terminal: handle }
  const start = (sessionId: string) =>
    dispatch(orchestrationRequest('orchestration.workerStart', retry, { sessionId }))
  const savedTask = db.getTask(task.id)
  const savedWorker = db.getWorkerDispatch(stopped.id)
  const savedResource = db.getWorkerTerminalResourceByHandle(handle)
  expect(savedWorker).toMatchObject({ state: 'stopped', stage: 'process_stopped' })
  expect(savedResource).toMatchObject({ owner_dispatch_id: stopped.id, ownership_state: 'owned' })

  expect(await start(SESSION_X)).toMatchObject({
    ok: false,
    error: {
      code: 'worker_unreachable',
      message: expect.stringContaining(`Agent session ${SESSION_Y} has ended`),
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
  expect(db.getTask(task.id)).toEqual(savedTask)
  expect(db.getDispatchContext(task.id)?.id).toBe(stopped.id)
  expect(db.getWorkerDispatch(stopped.id)).toEqual(savedWorker)
  expect(db.getWorkerTerminalResourceByHandle(handle)).toEqual(savedResource)
})
