import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

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
    db.updateTaskStatus(task, 'ready')
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
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method.handler(method.params!.parse(params), { runtime })
  }
})

function paneKey(handle: string): string {
  return `tab:${handle}`
}
