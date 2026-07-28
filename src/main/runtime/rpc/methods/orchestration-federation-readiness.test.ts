import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { waitForOrchestrationProvisioning } from './orchestration-agent-prompt-readiness'
import type { FederationEffect } from './orchestration-federation-effects'
import { failFederatedAttachmentWithReceipt } from './orchestration-federation-start-receipt'
import { createFederatedWorkerWorktree } from './orchestration-federation-worktree-provisioning'
import { finalizeRemoteWorkerAttachment } from './orchestration-worker-finalization'
import { provisionFederatedWorkerTerminal } from './orchestration-worker-terminal-provisioning'

describe('federated worker prompt readiness', () => {
  let db: OrchestrationDb

  afterEach(() => db.close())

  it('keeps remote attachment recovery blocked when prompt delivery is unknown', () => {
    db = new OrchestrationDb(':memory:')
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 2,
      runtimeEpoch: 'runtime-worker',
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'request-1',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'payload'
      }
    })
    const receipt = failFederatedAttachmentWithReceipt({
      db,
      dispatchId: 'ctx_remote',
      runtimeEpoch: 'runtime-worker',
      failedStage: 'dispatch_input',
      error: Object.assign(new Error('prompt write failed after paste'), {
        code: 'operation_unknown'
      }),
      setup: {
        requested: 'run',
        effective: 'run',
        source: 'orchestration_default',
        hookFound: true,
        startupPolicy: 'start-immediately',
        state: 'running'
      }
    })

    expect(receipt).toMatchObject({
      state: 'outcome_unknown',
      failedStage: 'dispatch_input'
    })
    expect(db.getRemoteDispatchAttachment('ctx_remote')?.state).toBe('start_unknown')
  })

  it('marks post-input finalization failures as unknown', () => {
    db = new OrchestrationDb(':memory:')
    vi.spyOn(db, 'markRemoteAttachmentReady').mockImplementationOnce(() => {
      throw new Error('database write failed')
    })

    expect(() => finalizeRemoteWorkerAttachment(db, 'ctx_remote', [])).toThrow(
      expect.objectContaining({ code: 'operation_unknown' })
    )
  })

  it('records late provisioning resources after the caller receives unknown', async () => {
    db = new OrchestrationDb(':memory:')
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 2,
      runtimeEpoch: 'runtime-worker',
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'request-late',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'payload-late'
      }
    })
    let finishCreate!: (value: unknown) => void
    const runtime = {
      createManagedWorktree: vi.fn(
        async () => await new Promise((resolve) => (finishCreate = resolve))
      ),
      listTerminals: vi.fn(async () => ({
        terminals: [{ handle: 'term_remote', title: 'Codex' }]
      }))
    } as unknown as OrcaRuntimeService
    const controller = new AbortController()
    const effects: never[] = []
    const provisioning = createFederatedWorkerWorktree({
      runtime,
      db,
      dispatchId: 'ctx_remote',
      repo: 'repo',
      name: 'worker',
      setupDecision: 'run',
      setupSource: 'orchestration_default',
      agent: 'codex',
      signal: controller.signal,
      terminalIdentity: {
        agentSessionCreateOperationId: 'a'.repeat(43),
        tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        preAllocatedHandle: 'term_preallocated'
      },
      effects
    })
    const waited = waitForOrchestrationProvisioning(provisioning, controller.signal)
    controller.abort()
    await expect(waited).rejects.toMatchObject({ code: 'operation_unknown' })
    failFederatedAttachmentWithReceipt({
      db,
      dispatchId: 'ctx_remote',
      runtimeEpoch: 'runtime-worker',
      failedStage: 'worktree_create',
      error: Object.assign(new Error('request_aborted'), { code: 'operation_unknown' }),
      setup: {
        requested: 'run',
        effective: 'run',
        source: 'orchestration_default',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_configured'
      }
    })
    finishCreate({
      worktree: { id: 'repo::worker', repoId: 'repo' },
      startupTerminal: { spawned: true, handle: 'term_remote' },
      setupReceipt: {
        requested: 'run',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_configured'
      }
    })
    await provisioning

    expect(db.getRemoteDispatchAttachment('ctx_remote')).toMatchObject({
      state: 'start_unknown',
      worktree_id: 'repo::worker',
      terminal_handle: 'term_remote'
    })
  })

  it('records deterministic startup identity when federated creation returns unknown', async () => {
    db = new OrchestrationDb(':memory:')
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 2,
      runtimeEpoch: 'runtime-worker',
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'request-worktree-unknown',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'payload-worktree-unknown'
      }
    })
    const runtime = {
      createManagedWorktree: vi.fn().mockRejectedValue(
        Object.assign(new Error('execution_owner_unavailable'), {
          agentSessionOperationOutcome: 'unknown'
        })
      )
    } as unknown as OrcaRuntimeService
    const effects: FederationEffect[] = []

    await expect(
      createFederatedWorkerWorktree({
        runtime,
        db,
        dispatchId: 'ctx_remote',
        repo: 'repo',
        name: 'worker',
        setupDecision: 'run',
        setupSource: 'orchestration_default',
        agent: 'codex',
        signal: new AbortController().signal,
        terminalIdentity: {
          agentSessionCreateOperationId: 'a'.repeat(43),
          tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          preAllocatedHandle: 'term_preallocated'
        },
        effects
      })
    ).rejects.toMatchObject({ code: 'operation_unknown' })
    expect(db.getRemoteDispatchAttachment('ctx_remote')).toMatchObject({
      stage: 'terminal_creation_committed',
      terminal_handle: 'term_preallocated'
    })
    expect(effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'created_pending_receipt',
          id: 'term_preallocated'
        })
      ])
    )
  })

  it('keeps federated startup fenced when post-create enumeration fails', async () => {
    db = new OrchestrationDb(':memory:')
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 2,
      runtimeEpoch: 'runtime-worker',
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'request-enumeration-failure',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'payload-enumeration-failure'
      }
    })
    const runtime = {
      createManagedWorktree: vi.fn(async (options) => {
        options.startupTerminalIdentity?.onPtySpawnCommitted?.()
        return {
          worktree: { id: 'repo::worker', repoId: 'repo' },
          startupTerminal: { spawned: true, handle: 'term_worker', surface: 'background' }
        }
      }),
      listTerminals: vi.fn().mockRejectedValue(new Error('terminal enumeration failed'))
    } as unknown as OrcaRuntimeService
    const effects: FederationEffect[] = []

    await expect(
      createFederatedWorkerWorktree({
        runtime,
        db,
        dispatchId: 'ctx_remote',
        repo: 'repo',
        name: 'worker',
        setupDecision: 'run',
        setupSource: 'orchestration_default',
        agent: 'codex',
        signal: new AbortController().signal,
        terminalIdentity: {
          agentSessionCreateOperationId: 'a'.repeat(43),
          tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          preAllocatedHandle: 'term_preallocated'
        },
        effects
      })
    ).rejects.toMatchObject({ code: 'operation_unknown' })
    expect(db.getRemoteDispatchAttachment('ctx_remote')).toMatchObject({
      stage: 'worktree_created',
      terminal_handle: 'term_preallocated'
    })
  })

  it('keeps a federated worktree fenced when post-create reconciliation fails', async () => {
    db = new OrchestrationDb(':memory:')
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 2,
      runtimeEpoch: 'runtime-worker',
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'request-worktree-commit',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'payload-worktree-commit'
      }
    })
    const runtime = {
      createManagedWorktree: vi.fn(async (options) => {
        options.onWorktreeCreateCommitted?.({
          id: 'repo::worker',
          path: '/workspace/worker',
          branch: 'worker'
        })
        throw new Error('post-create listing failed')
      })
    } as unknown as OrcaRuntimeService
    const effects: FederationEffect[] = []

    await expect(
      createFederatedWorkerWorktree({
        runtime,
        db,
        dispatchId: 'ctx_remote',
        repo: 'repo',
        name: 'worker',
        setupDecision: 'run',
        setupSource: 'orchestration_default',
        agent: 'codex',
        signal: new AbortController().signal,
        terminalIdentity: {
          agentSessionCreateOperationId: 'a'.repeat(43),
          tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          preAllocatedHandle: 'term_preallocated'
        },
        effects
      })
    ).rejects.toMatchObject({ code: 'operation_unknown' })
    expect(db.getRemoteDispatchAttachment('ctx_remote')).toMatchObject({
      stage: 'worktree_creation_committed',
      worktree_id: 'repo::worker'
    })
    expect(effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'created_top_level',
          id: 'repo::worker'
        })
      ])
    )
  })

  it('persists federated canonical worktree identity before a later stage can fail', async () => {
    db = new OrchestrationDb(':memory:')
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 2,
      runtimeEpoch: 'runtime-worker',
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'request-canonical-worktree',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'payload-canonical-worktree'
      }
    })
    const runtime = {
      createManagedWorktree: vi.fn(async (options) => {
        options.onWorktreeCreateCommitted?.({
          id: 'repo::requested-path',
          path: '/workspace/requested-path',
          branch: 'worker'
        })
        return {
          worktree: { id: 'repo::canonical-path', repoId: 'repo' },
          startupTerminal: { spawned: true, handle: 'term_worker', surface: 'background' }
        }
      })
    } as unknown as OrcaRuntimeService
    const recordStage = db.recordRemoteAttachmentStage.bind(db)
    vi.spyOn(db, 'recordRemoteAttachmentStage').mockImplementation((params) => {
      if (params.stage === 'worktree_created') {
        throw new Error('later stage persistence failed')
      }
      return recordStage(params)
    })

    await expect(
      createFederatedWorkerWorktree({
        runtime,
        db,
        dispatchId: 'ctx_remote',
        repo: 'repo',
        name: 'worker',
        setupDecision: 'run',
        setupSource: 'orchestration_default',
        agent: 'codex',
        signal: new AbortController().signal,
        terminalIdentity: {
          agentSessionCreateOperationId: 'a'.repeat(43),
          tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          preAllocatedHandle: 'term_preallocated'
        },
        effects: []
      })
    ).rejects.toMatchObject({ code: 'operation_unknown' })
    expect(db.getRemoteDispatchAttachment('ctx_remote')).toMatchObject({
      stage: 'worktree_creation_committed',
      worktree_id: 'repo::canonical-path'
    })
    expect(JSON.parse(db.getRemoteDispatchAttachment('ctx_remote')!.residual_resources)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'repo::canonical-path' })])
    )
  })

  it('records a federated terminal that resolves after cancellation', async () => {
    db = new OrchestrationDb(':memory:')
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 2,
      runtimeEpoch: 'runtime-worker',
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'request-terminal-late',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'payload-terminal-late'
      }
    })
    let finishCreate!: (terminal: { handle: string; worktreeId: string; title: string }) => void
    const runtime = {
      createTerminal: vi.fn(async () => await new Promise((resolve) => (finishCreate = resolve)))
    } as unknown as OrcaRuntimeService
    const controller = new AbortController()
    const effects: FederationEffect[] = []
    const pending = provisionFederatedWorkerTerminal({
      runtime,
      db,
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      worktreeId: 'repo::worker',
      agent: 'codex',
      signal: controller.signal,
      terminalIdentity: {
        agentSessionCreateOperationId: 'a'.repeat(43),
        tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        preAllocatedHandle: 'term_preallocated'
      },
      effects
    })

    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'operation_unknown' })
    failFederatedAttachmentWithReceipt({
      db,
      dispatchId: 'ctx_remote',
      runtimeEpoch: 'runtime-worker',
      failedStage: 'terminal_create',
      error: Object.assign(new Error('request_aborted'), { code: 'operation_unknown' }),
      setup: {
        requested: 'not_applicable',
        effective: 'not_applicable',
        source: 'existing_worktree',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_applicable'
      }
    })
    finishCreate({
      handle: 'term_remote',
      worktreeId: 'repo::worker',
      title: 'worker'
    })
    await vi.waitFor(() => {
      expect(db.getRemoteDispatchAttachment('ctx_remote')).toMatchObject({
        state: 'start_unknown',
        stage: 'terminal_created',
        terminal_handle: 'term_remote'
      })
    })
  })

  it('marks federated post-spawn publication failure as unknown', async () => {
    db = new OrchestrationDb(':memory:')
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer',
      protocolVersion: 2,
      runtimeEpoch: 'runtime-worker',
      mutationReceipt: {
        callerFingerprint: 'peer',
        requestId: 'request-terminal-commit',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'payload-terminal-commit'
      }
    })
    const runtime = {
      createTerminal: vi.fn(async (_selector, options) => {
        options?.onPtySpawnCommitted?.()
        throw new Error('post-spawn publication failed')
      })
    } as unknown as OrcaRuntimeService
    const effects: FederationEffect[] = []

    await expect(
      provisionFederatedWorkerTerminal({
        runtime,
        db,
        dispatchId: 'ctx_remote',
        taskId: 'task_remote',
        worktreeId: 'repo::worker',
        agent: 'codex',
        signal: new AbortController().signal,
        terminalIdentity: {
          agentSessionCreateOperationId: 'a'.repeat(43),
          tabId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          preAllocatedHandle: 'term_preallocated'
        },
        effects
      })
    ).rejects.toMatchObject({ code: 'operation_unknown' })
    expect(db.getRemoteDispatchAttachment('ctx_remote')).toMatchObject({
      stage: 'terminal_creation_committed',
      terminal_handle: 'term_preallocated'
    })
  })
})
