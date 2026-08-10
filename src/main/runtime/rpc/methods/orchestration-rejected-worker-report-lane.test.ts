import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { reconcileLifecycleMessage } from '../../orchestration/lifecycle-reconciliation'
import { WORKER_REPORT_REJECTED_STAGE } from '../../orchestration/types'
import { ORCHESTRATION_METHODS } from './orchestration'

const COORDINATOR = 'term_coordinator'
const WORKER = 'term_worker'
const OUTSIDER = 'term_outsider'

describe('rejected worker_done Dispatch state', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let taskId: string
  let dispatchId: string
  let capability: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => paneKey(handle))
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
      (handle) => `${handle}:process`
    )
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(runtime, 'deliverPendingMessagesForHandle').mockImplementation(() => {})

    runId = db.createRun({
      objective: 'Report a finished worker',
      coordinatorHandle: COORDINATOR,
      coordinatorPaneKey: paneKey(COORDINATOR)
    }).id
    taskId = db.createTask({ spec: 'supervised work', runId }).id
    const started = db.createStartingWorkerDispatch({ taskId, startOptions: {} })
    dispatchId = started.dispatch.id
    capability = db.prepareStartingWorkerAuthority({
      dispatchId,
      handle: WORKER,
      paneKey: paneKey(WORKER),
      processIncarnation: `${WORKER}:process`,
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    db.markWorkerDispatchReady(dispatchId)
  })

  afterEach(() => db.close())

  it('parks the lane when the assignee reports without its Dispatch capability', async () => {
    const rejected = (await send({})) as { lifecycle: { action: string; code: string } }

    expect(rejected.lifecycle).toMatchObject({
      action: 'rejected',
      code: 'dispatch_capability_invalid'
    })
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'stop_unknown',
      stage: WORKER_REPORT_REJECTED_STAGE,
      last_error: expect.stringContaining('capability')
    })
  })

  it('parks the lane when the report loses to a revoked Dispatch', async () => {
    db.failDispatch(dispatchId, 'the worker never reported readiness')

    const rejected = (await send({ capability })) as { lifecycle: { action: string } }

    expect(rejected.lifecycle.action).toBe('rejected')
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'stop_unknown',
      stage: WORKER_REPORT_REJECTED_STAGE
    })
  })

  it('parks the lane when settlement rejects a Task that left the dispatched state', () => {
    db.updateTaskStatus(taskId, 'blocked')
    const message = db.insertMessage({
      from: WORKER,
      to: `run:${runId}`,
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' }),
      senderPaneKey: paneKey(WORKER),
      runId
    })

    expect(reconcileLifecycleMessage(db, message)).toMatchObject({
      action: 'rejected',
      code: 'inactive_dispatch'
    })
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'stop_unknown',
      stage: WORKER_REPORT_REJECTED_STAGE
    })
  })

  it('leaves the lane alone when a terminal that is not the assignee reports', async () => {
    const rejected = (await send({ from: OUTSIDER })) as { lifecycle: { code: string } }

    expect(rejected.lifecycle.code).toBe('dispatch_capability_invalid')
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'ready',
      stage: 'input_accepted'
    })
  })

  it('settles the lane when the report is accepted', async () => {
    const accepted = (await send({ capability })) as { lifecycle?: unknown }

    expect(accepted.lifecycle).toBeUndefined()
    expect(db.getTask(taskId)?.status).toBe('completed')
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'succeeded',
      stage: 'settled'
    })
  })

  it('settles a parked lane when the worker retries with its capability', async () => {
    await send({})
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('stop_unknown')

    await send({ capability })

    expect(db.getTask(taskId)?.status).toBe('completed')
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'succeeded',
      stage: 'settled',
      last_error: null
    })
  })

  it('still requeues the Task when a parked lane loses its terminal', async () => {
    await send({})

    expect(db.reconcileMissingWorkerTerminal(dispatchId, 'worker terminal is gone')).toMatchObject({
      state: 'abandoned'
    })
    expect(db.getTask(taskId)?.status).toBe('ready')
  })

  async function send(options: { from?: string; capability?: string }): Promise<unknown> {
    const method = ORCHESTRATION_METHODS.find(
      (candidate) => candidate.name === 'orchestration.send'
    )
    if (!method) {
      throw new Error('orchestration.send was not registered')
    }
    return method.handler(
      method.params!.parse({
        from: options.from ?? WORKER,
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
      }),
      { runtime, orchestrationCapability: options.capability }
    )
  }
})

function paneKey(handle: string): string {
  return `tab:${handle}`
}
