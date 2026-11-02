import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../../../../sqlite/sync-database'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { eraseRpcMethods, type RpcContext } from '../../../core'
import { parseOrcaSessionAddress } from '../../../../../../shared/orca-session-address'

const COORDINATOR = 'term_coordinator'
const TARGET = 'term_target'
const OTHER = 'term_other'
const SUPERVISED = 'term_supervised'

describe('manual Dispatch release', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => paneKey(handle))
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
      (handle) => `${handle}:process`
    )
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({ closed: true } as never)
    runId = db.createRun({
      objective: 'Release manual Dispatches',
      coordinatorHandle: COORDINATOR,
      coordinatorPaneKey: paneKey(COORDINATOR)
    }).id
  })

  afterEach(() => db.close())

  it.each([
    ['orchestration.workerAbandon', 'abandoned'],
    ['orchestration.workerStop', 'stopped']
  ] as const)('releases a context-only Dispatch through %s', async (method, expectedState) => {
    const unrelated = await dispatchNewTask(OTHER, 'unrelated')
    const supervised = createSupervisedWorker()
    const targetTask = createTask('target')
    const targetDispatch = await dispatchTask(targetTask, TARGET)
    const question = db.createQuestion({
      runId,
      dispatchId: targetDispatch,
      askerHandle: TARGET,
      question: 'Can this assignment finish?'
    })
    expect(db.getWorkerDispatch(targetDispatch)).toBeUndefined()
    await expect(call('orchestration.dispatchShow', { task: targetTask })).resolves.toMatchObject({
      dispatch: { id: targetDispatch, status: 'dispatched' }
    })

    const notify = vi.spyOn(runtime, 'notifyMessageArrived')
    notify.mockClear()
    const released = (await call(method, { dispatch: targetDispatch })) as {
      state: string
      alreadySettled: boolean
      processAction: string
      residualResources?: unknown[]
    }
    expect(released).toMatchObject({
      state: expectedState,
      alreadySettled: false,
      processAction: 'none'
    })
    if (method === 'orchestration.workerAbandon') {
      expect(released.residualResources).toEqual([])
    }

    expect(db.getDispatchContextById(targetDispatch)).toMatchObject({
      status: 'failed',
      last_failure: expectedState,
      capability_revoked_at: expect.any(String),
      completed_at: expect.any(String)
    })
    expect(db.getTask(targetTask)?.status).toBe('blocked')
    expect(db.getQuestion(question.message.id)?.status).toBe('closed')
    expect(db.getActiveDispatchForIdentity(TARGET, paneKey(TARGET))).toBeUndefined()
    expect(runtime.closeTerminal).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(`dispatch:${targetDispatch}`, 'status')

    expect(db.getDispatchContextById(unrelated)).toMatchObject({ status: 'dispatched' })
    expect(db.getWorkerDispatch(supervised)).toMatchObject({ state: 'ready' })
    expect(db.getDispatchContextById(supervised)).toMatchObject({ status: 'dispatched' })

    const oppositeMethod =
      method === 'orchestration.workerAbandon'
        ? 'orchestration.workerStop'
        : 'orchestration.workerAbandon'
    await expect(call(oppositeMethod, { dispatch: targetDispatch })).resolves.toMatchObject({
      state: expectedState,
      alreadySettled: true,
      processAction: 'none'
    })
    expect(notify).toHaveBeenCalledTimes(1)

    const replacement = await dispatchNewTask(TARGET, 'replacement')
    expect(replacement).not.toBe(targetDispatch)
    expect(db.getActiveDispatchForIdentity(TARGET, paneKey(TARGET))?.id).toBe(replacement)
  })

  it('fences a superseded context without blocking its current replacement', async () => {
    const task = createTask('superseded')
    const superseded = await dispatchTask(task, TARGET)
    // Why: recovery still needs coverage for contradictory rows persisted before ready resets were guarded.
    sqliteFor(db).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task)
    const current = await dispatchTask(task, OTHER)

    await expect(call('orchestration.workerStop', { dispatch: superseded })).resolves.toMatchObject(
      {
        state: 'stopped',
        alreadySettled: false,
        processAction: 'none'
      }
    )

    expect(db.getDispatchContextById(superseded)).toMatchObject({
      status: 'failed',
      last_failure: 'stopped'
    })
    expect(db.getDispatchContextById(current)).toMatchObject({ status: 'dispatched' })
    expect(db.getTask(task)?.status).toBe('dispatched')
    expect(db.getActiveDispatchForIdentity(TARGET, paneKey(TARGET))).toBeUndefined()
    expect(db.getActiveDispatchForIdentity(OTHER, paneKey(OTHER))?.id).toBe(current)
    expect(runtime.closeTerminal).not.toHaveBeenCalled()

    await expect(dispatchNewTask(TARGET, 'reuses superseded terminal')).resolves.toMatch(/^ctx_/)
  })

  it('keeps unknown Dispatch errors honest', async () => {
    await expect(
      call('orchestration.workerAbandon', { dispatch: 'ctx_missing' })
    ).rejects.toMatchObject({ code: 'dispatch_not_found' })
    await expect(
      call('orchestration.workerStop', { dispatch: 'ctx_missing' })
    ).rejects.toMatchObject({ code: 'dispatch_not_found' })
  })

  function createTask(spec: string): string {
    return db.createTask({ spec, runId }).id
  }

  async function dispatchNewTask(handle: string, spec: string): Promise<string> {
    return dispatchTask(createTask(spec), handle)
  }

  async function dispatchTask(taskId: string, handle: string): Promise<string> {
    const result = (await call('orchestration.dispatch', {
      task: taskId,
      run: runId,
      from: COORDINATOR,
      to: handle
    })) as { dispatch: { id: string } }
    return result.dispatch.id
  }

  function createSupervisedWorker(): string {
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: createTask('supervised'),
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: SUPERVISED,
      paneKey: paneKey(SUPERVISED),
      processIncarnation: `${SUPERVISED}:process`,
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return started.dispatch.id
  }

  async function call(name: string, params: Record<string, unknown>): Promise<unknown> {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (candidate) => candidate.name === name
    )
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method.handler(method.params!.parse(params), { runtime })
  }
})

function paneKey(handle: string): string {
  return `tab:${handle}`
}

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('orchestration.workerAbandon', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
  })
  afterEach(() => db.close())

  function readyWorker(): string {
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'abandon caller' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 9
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      processIncarnation: 'inc_worker',
      worktreeId: 'wt',
      effects: [],
      setupState: 'not_configured'
    })
    db.markWorkerDispatchReady(dispatch.id)
    return dispatch.id
  }

  async function abandon(dispatchId: string, ctx: Partial<RpcContext>) {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (m) => m.name === 'orchestration.workerAbandon'
    )!
    return method.handler(method.params!.parse({ dispatch: dispatchId }), { runtime, ...ctx })
  }

  it('never records an unverified terminal handle as the one who abandoned the worker', async () => {
    const dispatchId = readyWorker()

    await expect(
      abandon(dispatchId, { orchestrationCompatibilityEvidence: { terminalHandle: 'term_coord' } })
    ).resolves.toMatchObject({ state: 'abandoned', alreadySettled: false })
    expect(db.getWorkerDispatch(dispatchId)?.last_error).toBe(
      'Abandoned by an unidentified caller.'
    )
  })

  it('records the resolved Orca session as the one who abandoned the worker', async () => {
    const dispatchId = readyWorker()
    const orcaSessionId = parseOrcaSessionAddress('orca_session_id:chat_1')!
    const session: OrchestrationSessionCaller = {
      address: 'orca_session_id:chat_1',
      terminalHandle: null,
      paneKey: null,
      orcaSessionId,
      sessionId: orcaSessionId,
      workspaceId: 'wt'
    }

    await abandon(dispatchId, {
      orchestrationCaller: session,
      orchestrationCompatibilityEvidence: { terminalHandle: 'term_coord' }
    })
    expect(db.getWorkerDispatch(dispatchId)?.last_error).toBe(
      'Abandoned by orca_session_id:chat_1.'
    )
  })

  it('reports an already-settled worker as stale and changes nothing', async () => {
    const dispatchId = readyWorker()
    db.failDispatch(dispatchId, 'tab closed', { workerProcessExited: true })
    const before = db.getWorkerDispatch(dispatchId)

    await expect(abandon(dispatchId, {})).resolves.toMatchObject({
      state: 'failed',
      alreadySettled: true,
      stale: true
    })
    expect(db.getWorkerDispatch(dispatchId)).toEqual(before)
  })
})
