/** Drives the workflow controller against Orca's real orchestration RPCs and database; only PTY spawning is replaced. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../shared/protocol-version'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { authenticationFeatureTemplate } from '../../shared/workflow/workflow-templates-team'
import { currentWorkflowTask } from '../../shared/workflow/workflow-run-state'
import type { WorkflowRun } from '../../shared/workflow/workflow-run-types'
import { WorkflowController } from './workflow-controller'
import { createWorkflowOrcaAdapter } from './workflow-orca-adapter'
import type { WorkflowOrcaAdapter } from './workflow-orca-adapter-contract'
import { record } from './workflow-orca-receipts'
import type { RpcResponse } from '../runtime/rpc/core'
import { WorkflowStore } from './workflow-store'

const COORDINATOR = 'term_coord'
let requestCounter = 0

type Rig = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  dir: string
  /** The worker terminal each node's attempt was assigned to. */
  workers: Map<string, { handle: string; taskId: string; dispatchId: string }>
  send: (method: string, params: Record<string, unknown>) => Promise<RpcResponse>
  controller: (store?: WorkflowStore) => WorkflowController
}

function createRig(): Rig {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const panes = new Map<string, string>([
    [COORDINATOR, 'tab_coord:11111111-1111-4111-8111-111111111111']
  ])
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => panes.get(handle) ?? null)
  vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation(
    (handle) => panes.get(handle) ?? null
  )
  const dispatcher = new RpcDispatcher({ runtime })
  const send: Rig['send'] = async (method, params) => {
    requestCounter += 1
    const id = `test-${requestCounter}`
    return dispatcher.dispatch(
      {
        id,
        authToken: 't',
        method,
        params,
        orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
        orchestrationRequestId: id
      },
      { caller: { kind: 'local-cli' } }
    )
  }
  const workers: Rig['workers'] = new Map()
  let workerCount = 0
  const dir = mkdtempSync(join(tmpdir(), 'orca-workflow-'))
  const adapterFor = (): WorkflowOrcaAdapter => {
    const real = createWorkflowOrcaAdapter(runtime)
    return {
      ...real,
      createCoordinatorTerminal: async () => COORDINATOR,
      closeTerminal: async () => undefined,
      // Stand-in for a PTY launch: assign the real Orca Task to a fake worker terminal.
      startWorker: async (args) => {
        workerCount += 1
        const handle = `term_${args.displayName.replace(/\W+/g, '_').toLowerCase()}_${workerCount}`
        panes.set(
          handle,
          `tab_${handle}:22222222-2222-4222-8222-${String(workerCount).padStart(12, '0')}`
        )
        if (args.retryOf) {
          // worker-start --retry-of moves the failed Task into its new Dispatch with this same guarded transition.
          db.transitionLifecycle({
            entity: 'task',
            id: args.orcaTaskId,
            from: 'failed',
            to: 'ready'
          })
        }
        const response = await send('orchestration.dispatch', {
          task: args.orcaTaskId,
          to: handle,
          from: args.from,
          run: args.orcaRunId
        })
        if (!response.ok) {
          throw new Error(`dispatch refused: ${response.error.code} ${response.error.message}`)
        }
        const dispatch = record(record(response.result).dispatch)
        if (typeof dispatch.id !== 'string') {
          throw new Error('dispatch returned no id')
        }
        workers.set(args.displayName, {
          handle,
          taskId: args.orcaTaskId,
          dispatchId: dispatch.id
        })
        return {
          orcaDispatchId: dispatch.id,
          orcaTaskId: args.orcaTaskId,
          terminalHandle: handle,
          worktreeId: 'wt_1',
          state: 'ready',
          effective: { agent: args.agent, model: args.model, effort: args.effort },
          failedStage: null,
          error: null
        }
      }
    }
  }
  return {
    runtime,
    db,
    dir,
    workers,
    send,
    controller: (store = new WorkflowStore(dir)) =>
      new WorkflowController(store, adapterFor(), { reconcileIntervalMs: 100 })
  }
}

async function workerDone(
  rig: Rig,
  label: string,
  body: string,
  outcome: 'succeeded' | 'failed' = 'succeeded'
) {
  const worker = rig.workers.get(label)!
  return rig.send('orchestration.send', {
    from: worker.handle,
    type: 'worker_done',
    subject: `${label} ${outcome}`,
    body,
    payload: JSON.stringify({ taskId: worker.taskId, dispatchId: worker.dispatchId, outcome })
  })
}

describe('workflow controller on the Orca runtime', () => {
  let rig: Rig
  let controller: WorkflowController

  beforeEach(() => {
    rig = createRig()
    controller = rig.controller()
  })

  afterEach(() => {
    controller.dispose()
    rig.db.close()
    rmSync(rig.dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const status = (run: WorkflowRun, nodeId: string) =>
    currentWorkflowTask(controller.store.getRun(run.id)!, nodeId).status

  it('runs the authentication example through real Runs, Tasks and Dispatches, enforcing its routes', async () => {
    const preset = await controller.savePreset({
      ...authenticationFeatureTemplate(),
      id: 'auth',
      template: false
    })
    const run = await controller.startRun({
      presetId: preset.id,
      objective: 'Add login',
      worktreeSelector: 'id:wt_1',
      worktreeLabel: 'main'
    })
    await vi.waitFor(() => expect(status(run, 'coordinator')).toBe('running'))
    const orcaRunId = controller.store.getRun(run.id)!.orcaRunId!
    expect(rig.db.getRun(orcaRunId)?.coordinator_handle).toBe(COORDINATOR)

    const plan =
      'Planned.\nWORKFLOW_RESULT: {"tasks":{"backend":"Build POST /login","frontend":"Build the login form"},"apiContract":"POST /login"}'
    expect((await workerDone(rig, 'Coordinator', plan)).ok).toBe(true)
    await vi.waitFor(() =>
      expect([status(run, 'backend'), status(run, 'frontend')]).toEqual(['running', 'running'])
    )

    // The backend was told only its own task; the frontend's spec never reached it.
    const backendSpec = rig.db.getTask(rig.workers.get('Backend Implementer')!.taskId)!.spec
    expect(backendSpec).toContain('Build POST /login')
    expect(backendSpec).not.toContain('Build the login form')

    // Backend → Frontend has no route: the real orchestration.send refuses it with no message written.
    const before = rig.db.getUnreadRunMailbox(orcaRunId, 100).length
    const refused = await rig.send('orchestration.send', {
      from: rig.workers.get('Backend Implementer')!.handle,
      to: `dispatch:${rig.workers.get('Frontend Implementer')!.dispatchId}`,
      subject: 'psst',
      body: 'use my schema'
    })
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: 'workflow_route_refused',
        data: { policyCode: 'route_not_permitted', effectsApplied: false }
      }
    })
    expect(rig.db.getUnreadRunMailbox(orcaRunId, 100).length).toBe(before)
    expect(controller.store.getRun(run.id)!.messages.at(-1)).toMatchObject({
      channel: 'direct',
      deliveryState: 'rejected'
    })

    await workerDone(rig, 'Backend Implementer', 'API done.')
    await workerDone(rig, 'Frontend Implementer', 'UI done.')
    await vi.waitFor(() => expect(status(run, 'reviewer')).toBe('running'))
    await workerDone(
      rig,
      'Reviewer',
      'Looks right.\nWORKFLOW_RESULT: {"verdict":"approved","findings":[]}'
    )

    await vi.waitFor(() => expect(controller.store.getRun(run.id)!.status).toBe('completed'))
    const done = controller.store.getRun(run.id)!
    expect(
      done.messages
        .filter((message) => message.channel === 'controller')
        .map((message) => message.edgeId)
    ).toEqual([
      'c-coordinator-backend',
      'c-coordinator-frontend',
      'c-backend-reviewer',
      'c-frontend-reviewer'
    ])
    expect(done.tasks['backend#0'].dispatches[0].effective).toEqual({
      agent: 'codex',
      model: null,
      effort: null
    })
  })

  it('retries a failed attempt as a new Dispatch and survives a controller restart mid-run', async () => {
    const template = authenticationFeatureTemplate()
    const coordinator = template.definition.nodes.find((node) => node.id === 'coordinator')!
    if (coordinator.kind !== 'coordinator') {
      throw new Error('expected coordinator')
    }
    coordinator.agent.execution.maxAttempts = 2
    const preset = await controller.savePreset({ ...template, id: 'auth-retry', template: false })
    const run = await controller.startRun({
      presetId: preset.id,
      objective: 'x',
      worktreeSelector: 'id:wt_1',
      worktreeLabel: 'main'
    })
    await vi.waitFor(() => expect(status(run, 'coordinator')).toBe('running'))
    const firstDispatch = rig.workers.get('Coordinator')!.dispatchId

    await workerDone(rig, 'Coordinator', 'Could not plan.', 'failed')
    await vi.waitFor(() =>
      expect(rig.workers.get('Coordinator')!.dispatchId).not.toBe(firstDispatch)
    )
    await vi.waitFor(() => expect(status(run, 'coordinator')).toBe('running'))
    expect(
      controller.store
        .getRun(run.id)!
        .tasks['coordinator#0'].dispatches.map((dispatch) => dispatch.attempt)
    ).toEqual([1, 2])

    // A report naming the superseded Dispatch is refused by Orca itself.
    const stale = await rig.send('orchestration.send', {
      from: rig.workers.get('Coordinator')!.handle,
      type: 'worker_done',
      subject: 'late',
      payload: JSON.stringify({
        taskId: rig.workers.get('Coordinator')!.taskId,
        dispatchId: firstDispatch,
        outcome: 'succeeded'
      })
    })
    expect(stale).toMatchObject({ ok: true, result: { lifecycle: { action: 'rejected' } } })
    expect(status(run, 'coordinator')).toBe('running')
    await vi.waitFor(() =>
      expect(
        controller.store
          .getRun(run.id)!
          .events.some((event) => event.message.startsWith('Orca rejected a stale report'))
      ).toBe(true)
    )

    controller.dispose()
    controller = rig.controller(new WorkflowStore(rig.dir))
    await controller.recoverAll()
    expect(
      controller.store.getRun(run.id)!.events.some((event) => event.kind === 'run-reconciled')
    ).toBe(true)
    await workerDone(
      rig,
      'Coordinator',
      'Planned.\nWORKFLOW_RESULT: {"tasks":{},"apiContract":"-"}'
    )
    await vi.waitFor(() => expect(status(run, 'backend')).toBe('running'))
  })

  it('leaves a run this process is already driving alone when startup recovery fires', async () => {
    const preset = await controller.savePreset({
      ...authenticationFeatureTemplate(),
      id: 'auth-live',
      template: false
    })
    const run = await controller.startRun({
      presetId: preset.id,
      objective: 'x',
      worktreeSelector: 'id:wt_1',
      worktreeLabel: 'main'
    })
    await vi.waitFor(() => expect(status(run, 'coordinator')).toBe('running'))

    await controller.recoverAll()

    const after = controller.store.getRun(run.id)!
    expect(after.events.some((event) => event.kind === 'run-reconciled')).toBe(false)
    expect(after.tasks['coordinator#0'].dispatches).toHaveLength(1)
    expect(rig.workers.size).toBe(1)
  })
})
