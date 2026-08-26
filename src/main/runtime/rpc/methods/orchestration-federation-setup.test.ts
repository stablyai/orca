import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'
import {
  monitorFederatedSetup,
  persistFederatedSetupWaitOutcome
} from './orchestration-federation-setup'
import type { WorkerSetupReceipt } from './orchestration-worker-topology'

describe('orchestration federated setup evidence', () => {
  const databases: OrchestrationDb[] = []
  const runtimes: OrcaRuntimeService[] = []

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) {
      runtime.stopOrchestrationFederationRelay()
    }
    for (const db of databases.splice(0)) {
      db.close()
    }
  })

  function createRuntime(): { db: OrchestrationDb; runtime: OrcaRuntimeService } {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    databases.push(db)
    runtimes.push(runtime)
    return { db, runtime }
  }

  it('records remote setup evidence once without changing attachment lifecycle', async () => {
    const { db, runtime } = createRuntime()
    const dispatchId = 'ctx_remote_setup'
    const effects = [
      {
        kind: 'terminal' as const,
        role: 'setup',
        action: 'created',
        id: 'term_remote_setup'
      },
      {
        kind: 'setup' as const,
        action: 'run',
        state: 'running'
      },
      {
        kind: 'dispatch_input' as const,
        role: 'agent',
        id: 'term_remote_worker',
        state: 'accepted'
      }
    ]
    db.createRemoteDispatchAttachment({
      dispatchId,
      taskId: 'task_remote_setup',
      homePeerFingerprint: 'home_peer',
      protocolVersion: 1,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: 'home_peer',
        requestId: 'request_remote_setup',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'remote_setup_payload'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'worker_epoch:pty:1',
      worktreeId: 'repo::remote-worktree',
      terminalHandle: 'term_remote_worker',
      setupState: 'running',
      effects
    })
    db.markRemoteAttachmentReady(dispatchId)
    vi.spyOn(runtime, 'waitForSetupTerminalCompletion').mockResolvedValue({ exitCode: 1 })
    const monitorArgs = {
      runtime,
      db,
      dispatchId,
      worktreeId: 'repo::remote-worktree',
      terminalHandle: 'term_remote_worker',
      setup: {
        requested: 'run' as const,
        effective: 'run' as const,
        source: 'orchestration_default',
        hookFound: true,
        startupPolicy: 'start-immediately' as const,
        state: 'running' as const
      },
      effects
    }

    monitorFederatedSetup(monitorArgs)
    monitorFederatedSetup(monitorArgs)

    await vi.waitFor(() =>
      expect(db.getRemoteDispatchAttachment(dispatchId)).toMatchObject({
        state: 'ready',
        stage: 'input_accepted',
        setup_state: 'failed'
      })
    )
    expect(
      db.listFederationRelay({ dispatchId, direction: 'to_home', afterSequence: 0 })
    ).toHaveLength(1)
    expect(JSON.parse(db.getRemoteDispatchAttachment(dispatchId)?.effects ?? '[]')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
      ])
    )
  })

  it('refreshes home setup evidence without changing a ready Dispatch lifecycle', async () => {
    const { db, runtime } = createRuntime()
    const run = db.createRun({
      objective: 'Observe remote setup',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'remote setup', runId: run.id })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      runtimeEpoch: runtime.getRuntimeId(),
      federation: {
        environmentId: 'environment_windows',
        environmentName: 'windows',
        peerFingerprint: 'windows_peer',
        protocolVersion: 1
      }
    })
    db.recordWorkerStage({
      dispatchId: started.dispatch.id,
      stage: 'terminal_readying',
      setupState: 'running',
      effects: [
        { kind: 'setup', action: 'run', state: 'running' },
        {
          kind: 'dispatch_input',
          role: 'agent',
          id: 'term_remote_worker',
          state: 'accepted'
        }
      ]
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    vi.spyOn(runtime, 'resolveOrchestrationWorkerServer').mockReturnValue({
      environmentId: 'environment_windows',
      name: 'windows',
      peerFingerprint: 'windows_peer'
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      runtimeEpoch: 'windows_epoch',
      attachment: {
        state: 'ready',
        stage: 'input_accepted',
        last_error: null,
        worktree_id: 'repo::remote-worktree',
        terminal_handle: 'term_remote_worker',
        setup_state: 'failed',
        effects: [
          { kind: 'setup', action: 'run', state: 'failed' },
          {
            kind: 'dispatch_input',
            role: 'agent',
            id: 'term_remote_worker',
            state: 'accepted'
          }
        ],
        residualResources: []
      },
      terminal: { handle: 'term_remote_worker', connected: true },
      observation: { status: 'running', exactWorker: true }
    })
    const workerShow = ORCHESTRATION_METHODS.find(
      (method) => method.name === 'orchestration.workerShow'
    )
    if (!workerShow) {
      throw new Error('workerShow method is not registered')
    }

    await expect(
      workerShow.handler(workerShow.params!.parse({ dispatch: started.dispatch.id }), { runtime })
    ).resolves.toMatchObject({
      observation: { status: 'live', exactWorker: true },
      worker: {
        state: 'ready',
        stage: 'input_accepted',
        setup_state: 'failed',
        effects: expect.arrayContaining([
          expect.objectContaining({ kind: 'setup', state: 'failed' }),
          expect.objectContaining({ kind: 'dispatch_input', state: 'accepted' })
        ])
      }
    })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
  })
})

describe('persistFederatedSetupWaitOutcome', () => {
  function federatedStage(setup: WorkerSetupReceipt, wait: { satisfied: boolean; status: string }) {
    const recordRemoteAttachmentStage = vi.fn()
    const db = { recordRemoteAttachmentStage } as unknown as OrchestrationDb
    persistFederatedSetupWaitOutcome({
      db,
      dispatchId: 'dispatch_remote_wait',
      worktreeId: 'repo::remote-worktree',
      terminalHandle: 'term_remote_worker',
      setup,
      effects: [{ kind: 'setup', action: 'run', state: setup.state }],
      wait
    })
    return recordRemoteAttachmentStage
  }

  it('records remote setup_settled only after a terminal transition', () => {
    const recordStage = federatedStage(
      {
        requested: 'run',
        effective: 'run',
        source: 'test',
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'running'
      },
      { satisfied: true, status: 'idle' }
    )
    expect(recordStage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'setup_settled', setupState: 'succeeded' })
    )
  })

  it('records nothing while the remote wait is unresolved', () => {
    const recordStage = federatedStage(
      {
        requested: 'run',
        effective: 'run',
        source: 'test',
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'running'
      },
      { satisfied: false, status: 'timeout' }
    )
    expect(recordStage).not.toHaveBeenCalled()
  })

  it('records nothing when the remote receipt already left the running state', () => {
    const recordStage = federatedStage(
      {
        requested: 'run',
        effective: 'run',
        source: 'test',
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'spawn_failed'
      },
      { satisfied: false, status: 'timeout' }
    )
    expect(recordStage).not.toHaveBeenCalled()
  })
})
