import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-launch-runtime-capability'
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

  it('resolves a remote target default before creating a home Dispatch', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    const run = db.createRun({
      objective: 'remote target',
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
      .mockImplementation(async (_environmentId, method) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
              PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY
            ]
          }
        }
        if (method === 'agent.resolveDefault') {
          return {
            agent: null,
            source: 'project',
            projectId: 'project-b',
            projectName: 'Project B'
          }
        }
        throw new Error(`Unexpected remote method: ${method}`)
      })

    await expect(
      startFederatedWorker({
        params: {
          task: task.id,
          from: 'term_coord',
          on: 'remote',
          worktree: 'new-top-level',
          name: 'remote-worker',
          repo: 'id:repo-b',
          agent: 'default'
        },
        runtime,
        db,
        runId: run.id,
        task,
        orchestrationMutation: {
          callerFingerprint: 'caller',
          requestId: 'remote_default',
          method: 'orchestration.workerStart',
          payloadHash: 'payload'
        }
      })
    ).rejects.toMatchObject({ code: 'agent_unconfigured' })

    expect(remoteCall.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'agent.resolveDefault'
    ])
    expect(remoteCall).toHaveBeenNthCalledWith(
      2,
      'environment_remote',
      'agent.resolveDefault',
      { repo: 'id:repo-b' },
      expect.any(Number),
      undefined,
      { expectedEnvironmentPairingRevision: 73 }
    )
    expect(db.getDispatchContext(task.id)).toBeUndefined()
    expect(db.getTask(task.id)?.status).toBe('ready')
  })

  it('passes the host-resolved agent through remote attachment and receipt', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    const run = db.createRun({
      objective: 'remote target',
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
    vi.spyOn(runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
              PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY
            ]
          }
        }
        if (method === 'agent.resolveDefault') {
          return {
            agent: 'codex',
            source: 'project',
            projectId: 'project-b',
            projectName: 'Project B'
          }
        }
        if (method === 'orchestration.federationAttachStart') {
          return {
            dispatchId: (params as { dispatchId: string }).dispatchId,
            state: 'ready',
            runtimeEpoch: 'remote_epoch',
            worktreeId: 'repo-b::new',
            terminalHandle: 'term_worker',
            launch: {
              requested: { agent: 'codex', model: null, effort: null },
              effective: { agent: 'codex', model: null, effort: null }
            },
            effects: [],
            residualResources: []
          }
        }
        throw new Error(`Unexpected remote method: ${method}`)
      })

    const result = await startFederatedWorker({
      params: {
        task: task.id,
        from: 'term_coord',
        on: 'remote',
        worktree: 'new-top-level',
        name: 'remote-worker',
        repo: 'id:repo-b',
        agent: 'default'
      },
      runtime,
      db,
      runId: run.id,
      task,
      orchestrationMutation: {
        callerFingerprint: 'caller',
        requestId: 'remote_default_ready',
        method: 'orchestration.workerStart',
        payloadHash: 'payload'
      }
    })

    expect(remoteCall.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'agent.resolveDefault',
      'orchestration.federationAttachStart'
    ])
    expect(remoteCall.mock.calls[2]?.[2]).toMatchObject({ agent: 'codex', repo: 'id:repo-b' })
    expect(result).toMatchObject({
      state: 'ready',
      agentSelection: {
        agent: 'codex',
        source: 'project',
        projectId: 'project-b'
      },
      launch: { effective: { agent: 'codex' } }
    })
  })

  it('rejects a default request on an older worker server before home mutation', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    const run = db.createRun({
      objective: 'remote target',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote work', runId: run.id })
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_remote',
      name: 'older remote',
      peerFingerprint: 'remote_peer',
      pairingRevision: 73
    })
    const remoteCall = vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      capabilities: [
        ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
        ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
      ]
    })

    await expect(
      startFederatedWorker({
        params: {
          task: task.id,
          from: 'term_coord',
          on: 'remote',
          worktree: 'new-top-level',
          name: 'remote-worker',
          repo: 'id:repo-b',
          agent: 'default'
        },
        runtime,
        db,
        runId: run.id,
        task,
        orchestrationMutation: {
          callerFingerprint: 'caller',
          requestId: 'remote_default_old',
          method: 'orchestration.workerStart',
          payloadHash: 'payload'
        }
      })
    ).rejects.toMatchObject({ code: 'capability_unsupported' })
    expect(remoteCall).toHaveBeenCalledTimes(1)
    expect(db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('pins a remote retry to its first agent and validates that agent before a new Dispatch', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    const run = db.createRun({
      objective: 'remote retry',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote retry work', runId: run.id })
    const first = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {
        agent: 'codex',
        agentSelection: { agent: 'codex', source: 'project', projectId: 'project-b' }
      }
    })
    db.failWorkerStart(first.dispatch.id, 'agent_readiness', 'agent failed')
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_remote',
      name: 'remote',
      peerFingerprint: 'remote_peer',
      pairingRevision: 73
    })
    vi.spyOn(runtime, 'ensureOrchestrationFederationRelay').mockImplementation(() => {})
    let available = false
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockImplementation(async (_environmentId, method, params) => {
        if (method === 'status.get') {
          return {
            capabilities: [
              ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
              ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
              PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY
            ]
          }
        }
        if (method === 'agent.resolveDefault') {
          if (!available) {
            throw new Error('Codex is unavailable on the execution host')
          }
          return { agent: 'codex', source: 'explicit', projectId: 'project-b' }
        }
        if (method === 'orchestration.federationAttachStart') {
          return {
            dispatchId: (params as { dispatchId: string }).dispatchId,
            state: 'ready',
            runtimeEpoch: 'remote_epoch',
            worktreeId: 'repo-b::new',
            terminalHandle: 'term_worker',
            launch: {
              requested: { agent: 'codex', model: null, effort: null },
              effective: { agent: 'codex', model: null, effort: null }
            },
            effects: [],
            residualResources: []
          }
        }
        throw new Error(`Unexpected remote method: ${method}`)
      })
    const params = {
      task: task.id,
      retryOf: first.dispatch.id,
      from: 'term_coord',
      on: 'remote',
      worktree: 'new-top-level',
      name: 'remote-worker',
      repo: 'id:repo-b',
      agent: 'default'
    }
    const start = (requestId: string) =>
      startFederatedWorker({
        params,
        runtime,
        db,
        runId: run.id,
        task,
        orchestrationMutation: {
          callerFingerprint: 'caller',
          requestId,
          method: 'orchestration.workerStart',
          payloadHash: 'payload'
        }
      })

    await expect(start('retry_unavailable')).rejects.toThrow(/Codex is unavailable/)
    expect(db.getDispatchContext(task.id)?.id).toBe(first.dispatch.id)
    expect(remoteCall.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'agent.resolveDefault'
    ])
    expect(remoteCall.mock.calls[1]?.[2]).toEqual({ repo: 'id:repo-b', validateAgent: 'codex' })

    available = true
    await expect(start('retry_available')).resolves.toMatchObject({
      state: 'ready',
      agentSelection: { agent: 'codex', source: 'project', projectId: 'project-b' },
      launch: { effective: { agent: 'codex' } }
    })
    expect(remoteCall.mock.calls.at(-1)?.[2]).toMatchObject({ agent: 'codex' })
  })
})
