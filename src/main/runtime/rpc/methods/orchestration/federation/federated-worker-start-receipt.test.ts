import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { startFederatedWorker } from './federated-worker-start'

describe('federated worker start receipt validation', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close()
    }
  })

  it('marks a malformed ready receipt outcome unknown without persisting resources', async () => {
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
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
            ]
          }
        }
        return {
          dispatchId: (params as { dispatchId: string }).dispatchId,
          state: 'ready',
          worktreeId: 'worktree_remote',
          terminalHandle: 'term_remote'
        }
      })

    const result = (await startFederatedWorker({
      params: {
        task: task.id,
        from: 'term_coord',
        on: 'remote',
        worktree: 'id:worktree_remote',
        terminal: 'term_remote'
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
    })) as { dispatchId: string; state: string; lastError?: string }

    expect(result).toMatchObject({
      state: 'outcome_unknown',
      lastError: 'The worker server returned an invalid ready receipt.'
    })
    expect(db.getFederatedDispatch(result.dispatchId)).toMatchObject({
      remote_runtime_epoch: null,
      remote_worktree_id: null,
      remote_terminal_handle: null
    })
    for (const call of remoteCall.mock.calls) {
      expect(call[5]).toEqual({
        ...(call[1] === 'orchestration.federationAttachStart' ? { contractVerified: true } : {}),
        expectedEnvironmentPairingRevision: 73
      })
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
          dispatchId: (params as { dispatchId: string }).dispatchId,
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
      runId: run.id,
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
    return JSON.parse(db.getWorkerDispatch(dispatchId)?.start_options ?? '{}')
  }

  it('records the agent the worker host resolved for an omitted --agent', async () => {
    const launch = {
      requested: { agent: null, model: null, effort: null },
      effective: { agent: 'codex', model: null, effort: null }
    }
    const startOptions = await startWithHostLaunch(launch)
    expect(startOptions).toMatchObject({ agent: 'codex', launch })
  })

  it('keeps the saved agent when the host names an unknown one', async () => {
    const launch = {
      requested: { agent: null, model: null, effort: null },
      effective: { agent: 'not-an-agent', model: null, effort: null }
    }
    const startOptions = await startWithHostLaunch(launch)
    expect(startOptions.agent).toBeNull()
  })
})
