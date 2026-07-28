import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { RpcDispatcher } from '../dispatcher'
import { ORCHESTRATION_METHODS } from './orchestration'
import { startFederatedWorker } from './orchestration-federated-worker-start'

describe('orchestration migration behavior', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close()
    }
  })

  function createRuntime(): { db: OrchestrationDb; runtime: OrcaRuntimeService } {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    return { db, runtime }
  }

  it('lists an explicitly selected legacy Run without binding or mutation', async () => {
    const { db, runtime } = createRuntime()
    const task = db.createTask({ spec: 'pre-upgrade work' })
    const taskList = ORCHESTRATION_METHODS.find(
      (method) => method.name === 'orchestration.taskList'
    )!

    const listed = (await taskList.handler(taskList.params!.parse({ run: 'run_legacy_local' }), {
      runtime
    })) as {
      runId: string
      legacyReadOnly: boolean
      tasks: { id: string }[]
    }

    expect(listed).toMatchObject({
      runId: 'run_legacy_local',
      legacyReadOnly: true,
      tasks: [{ id: task.id }]
    })
    expect(db.getTask(task.id)?.status).toBe('ready')
  })

  it('rejects a pre-contract worker_done before message or lifecycle mutation', async () => {
    const { db, runtime } = createRuntime()
    const run = db.createRun({
      objective: 'legacy worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'legacy worker', runId: run.id })
    const dispatch = db.createDispatchContext(task.id, 'term_worker', 'tab_worker:leaf_worker')
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })

    const response = await dispatcher.dispatch({
      id: 'legacy_worker_done',
      authToken: 'worker-token',
      method: 'orchestration.send',
      params: {
        from: 'term_worker',
        subject: 'done',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      }
    })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'orchestration_migration_required',
        data: { effectsApplied: false }
      }
    })
    expect(db.getInbox(100)).toHaveLength(0)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  it('rejects a connected server missing the contract before home or remote effects', async () => {
    const { db, runtime } = createRuntime()
    const run = db.createRun({
      objective: 'mixed-version worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_windows',
      name: 'windows',
      peerFingerprint: 'windows_peer'
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      capabilities: [ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY]
    })

    await expect(
      startFederatedWorker({
        params: {
          task: task.id,
          from: 'term_coord',
          on: 'windows',
          worktree: 'new-top-level',
          repo: 'id:windows-repo',
          name: 'remote-work',
          agent: 'codex'
        },
        runtime,
        db,
        runId: run.id,
        task,
        orchestrationMutation: {
          callerFingerprint: 'caller',
          requestId: 'remote_start',
          method: 'orchestration.workerStart',
          payloadHash: 'payload'
        }
      })
    ).rejects.toMatchObject({
      code: 'orchestration_migration_required',
      data: { reason: 'runtime_capability_missing', effectsApplied: false }
    })
    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('rejects a connected server missing federation support before Task mutation', async () => {
    const { db, runtime } = createRuntime()
    const run = db.createRun({
      objective: 'unsupported worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_windows',
      name: 'windows',
      peerFingerprint: 'windows_peer'
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      capabilities: [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY]
    })

    await expect(
      startFederatedWorker({
        params: {
          task: task.id,
          from: 'term_coord',
          on: 'windows',
          worktree: 'new-top-level',
          repo: 'id:windows-repo',
          name: 'remote-work',
          agent: 'codex'
        },
        runtime,
        db,
        runId: run.id,
        task,
        orchestrationMutation: {
          callerFingerprint: 'caller',
          requestId: 'remote_start',
          method: 'orchestration.workerStart',
          payloadHash: 'payload'
        }
      })
    ).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('preserves authenticated remote residuals when connected-server start is unknown', async () => {
    const { db, runtime } = createRuntime()
    const run = db.createRun({
      objective: 'unknown remote worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_windows',
      name: 'windows',
      peerFingerprint: 'windows_peer'
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockResolvedValueOnce({
        capabilities: [
          ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
          ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
        ]
      })
      .mockImplementationOnce(async (_selector, _method, params) => {
        const dispatchId = (params as { dispatchId: string }).dispatchId
        return {
          dispatchId,
          state: 'outcome_unknown',
          runtimeEpoch: 'runtime_windows',
          worktreeId: 'repo::worker',
          terminalHandle: 'term_preallocated',
          failedStage: 'terminal_create',
          lastError: 'terminal create reply was lost',
          setup: { state: 'not_applicable' },
          effects: [
            {
              kind: 'terminal',
              role: 'agent',
              action: 'created_pending_receipt',
              id: 'term_preallocated'
            }
          ],
          residualResources: [
            {
              kind: 'terminal',
              role: 'agent',
              action: 'created_pending_receipt',
              id: 'term_preallocated'
            }
          ]
        }
      })

    const result = (await startFederatedWorker({
      params: {
        task: task.id,
        from: 'term_coord',
        on: 'windows',
        worktree: 'id:repo::worker',
        agent: 'codex'
      },
      runtime,
      db,
      runId: run.id,
      task,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: 'remote_unknown',
        method: 'orchestration.workerStart',
        payloadHash: 'payload'
      }
    })) as {
      dispatchId: string
      state: string
      effects: unknown[]
      residualResources: unknown[]
    }

    expect(result).toMatchObject({
      state: 'outcome_unknown',
      effects: expect.arrayContaining([expect.objectContaining({ id: 'term_preallocated' })]),
      residualResources: expect.arrayContaining([
        expect.objectContaining({ id: 'term_preallocated' })
      ])
    })
    expect(db.getWorkerDispatch(result.dispatchId)).toMatchObject({
      state: 'start_unknown',
      worktree_id: 'repo::worker',
      agent_terminal_handle: 'term_preallocated'
    })
    expect(JSON.parse(db.getWorkerDispatch(result.dispatchId)!.residual_resources)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'term_preallocated' })])
    )
    expect(db.getFederatedDispatch(result.dispatchId)).toMatchObject({
      remote_runtime_epoch: 'runtime_windows',
      remote_worktree_id: 'repo::worker',
      remote_terminal_handle: 'term_preallocated'
    })
  })
})
