import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { startFederatedWorker } from './federated-worker-start'
import { workerStartOptionsAgent } from '../../../../orchestration/workers/launch/worker-launch-observation'

describe('federated worker start resolved agent', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close()
    }
  })

  async function startWithHostLaunch(launch: unknown) {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    const run = db.createRun({
      objective: 'federated worker',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_remote',
      name: 'remote',
      peerFingerprint: 'remote_peer',
      pairingRevision: 73
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockImplementation(
      async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
            ]
          }
        }
        return {
          dispatchId: String(Reflect.get(Object(params), 'dispatchId')),
          state: 'ready',
          runtimeEpoch: 'epoch_remote',
          worktreeId: 'worktree_remote',
          terminalHandle: 'term_remote',
          launch
        }
      }
    )
    const result = await startFederatedWorker({
      params: { task: task.id, from: 'term_coord', on: 'remote', worktree: 'id:worktree_remote' },
      runtime,
      db,
      bindRunId: () => run.id,
      taskDeps: undefined,
      task,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: 'remote_start',
        method: 'orchestration.workerStart',
        payloadHash: 'payload'
      }
    })
    expect(result).toMatchObject({ state: 'ready' })
    const dispatchId: string = Reflect.get(Object(result), 'dispatchId')
    return db.getWorkerDispatch(dispatchId)?.start_options ?? '{}'
  }

  it('shows the agent the worker host resolved for an omitted --agent', async () => {
    const startOptions = await startWithHostLaunch({
      requested: { agent: null, model: null, effort: null },
      effective: { agent: 'codex', model: null, effort: null }
    })
    expect(workerStartOptionsAgent(startOptions)).toBe('codex')
    expect(JSON.parse(startOptions).agent).toBeNull()
  })
})
