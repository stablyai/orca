import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { OrchestrationMutationExecutor } from './orchestration-mutation-executor'
import type { RpcRequest } from './core'

describe('worker-start transfer mutation recovery', () => {
  it('reports a reconciled pending transfer without invoking worker-start again', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-transfer-mutation-'))
    const databasePath = join(directory, 'orchestration.db')
    let db = new OrchestrationDb(databasePath)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({
      objective: 'recover',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab:coord'
    })
    const task = db.createTask({ runId: run.id, spec: 'recover transfer' })
    const generation = db.getRun(run.id)!.consumer_generation
    db.db
      .prepare(
        `INSERT INTO worker_terminal_resources (
        id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key,
        process_incarnation, ownership_state, release_state
      ) VALUES ('resource_1', 'ctx_old', 'ctx_old', 'term_worker', 'tab:worker', 'pty_1', 'owned', 'not_requested')`
      )
      .run()
    const predecessor = db.reserveMaestroTerminalLease({
      requestId: 'worker:old',
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      runId: run.id,
      taskId: task.id,
      attemptId: 'attempt_1',
      coordinatorGeneration: generation,
      role: 'worker',
      workerTerminalResourceId: 'resource_1',
      title: 'worker',
      launchProfile: {
        agent: null,
        model: null,
        effort: null,
        permissionMode: 'default',
        routeRef: null
      },
      spawnedBy: 'coordinator',
      ownerPrincipal: 'dispatch:ctx_old',
      retentionPolicy: 'auto_release'
    })
    db.attachMaestroTerminalLease({
      leaseId: predecessor.id,
      terminalHandle: 'term_worker',
      tabId: 'tab',
      paneKey: 'tab:worker',
      ptyIncarnation: 'pty_1',
      processRootId: 'pid_1'
    })
    db.transitionMaestroTerminalLease({ leaseId: predecessor.id, state: 'ready' })
    db.transitionMaestroTerminalLease({ leaseId: predecessor.id, state: 'active' })
    const params = { task: task.id, from: 'term_coord' }
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          method: 'orchestration.workerStart',
          params: { from: 'term_coord', task: task.id }
        })
      )
      .digest('hex')
    db.db
      .prepare(
        `INSERT INTO mutation_receipts (
        caller_fingerprint, request_id, method, payload_hash, state, receipt
      ) VALUES ('caller_1', 'request_1', 'orchestration.workerStart', ?, 'pending', ?)`
      )
      .run(payloadHash, JSON.stringify({ accepted: { dispatchId: 'ctx_new' } }))
    const receipt = db.transferMaestroWorkerTerminalLease({
      requestId: 'transfer_1',
      mutation: {
        callerFingerprint: 'caller_1',
        requestId: 'request_1',
        method: 'orchestration.workerStart',
        payloadHash
      },
      predecessorLeaseId: predecessor.id,
      successorRequestId: 'worker:new',
      kind: 'strict_retry',
      successorDispatchId: 'ctx_new',
      runId: run.id,
      taskId: task.id,
      attemptId: 'attempt_1',
      terminalHandle: 'term_worker',
      paneKey: 'tab:worker',
      ptyIncarnation: 'pty_1',
      processRootId: 'pid_1',
      executionHostId: 'local',
      workspaceKey: 'folder:one',
      hostScope: null,
      predecessorOwnerPrincipal: 'dispatch:ctx_old',
      successorOwnerPrincipal: 'dispatch:ctx_new',
      coordinatorGeneration: generation,
      retentionPolicy: 'auto_release',
      title: 'worker',
      launchProfile: {
        agent: null,
        model: null,
        effort: null,
        permissionMode: 'default',
        routeRef: null
      },
      spawnedBy: 'coordinator'
    })
    db.close()
    db = new OrchestrationDb(databasePath)
    const restartedRuntime = new OrcaRuntimeService()
    restartedRuntime.setOrchestrationDb(db)
    const invoke = vi.fn(() => ({ repeated: true }))
    const request: RpcRequest = {
      id: 'rpc_1',
      authToken: 'caller-token',
      method: 'orchestration.workerStart',
      params,
      orchestrationRequestId: 'request_1'
    }

    await expect(
      new OrchestrationMutationExecutor(restartedRuntime).run(request, params, invoke, 'caller_1')
    ).resolves.toMatchObject({ state: 'outcome_unknown', leaseTransfer: receipt })
    expect(invoke).not.toHaveBeenCalled()
    expect(
      db.db
        .prepare(
          `SELECT count(*) AS count FROM maestro_terminal_leases
         WHERE role = 'worker' AND lifecycle_state NOT IN ('released', 'superseded', 'archived')
           AND worker_terminal_resource_id = 'resource_1'`
        )
        .get()
    ).toEqual({ count: 1 })
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('re-enters a persisted federated release after an unverifiable result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-federated-release-mutation-'))
    const databasePath = join(directory, 'orchestration.db')
    const request: RpcRequest = {
      id: 'rpc_federated_release',
      method: 'orchestration.federationRelease',
      params: { dispatchId: 'dispatch_remote' },
      orchestrationRequestId: 'release_request_1'
    } as RpcRequest
    let db = new OrchestrationDb(databasePath)
    let runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const firstInvoke = vi.fn(() => ({ state: 'unverifiable', processAction: 'none' }))

    await expect(
      new OrchestrationMutationExecutor(runtime).run(
        request,
        request.params,
        firstInvoke,
        'remote_home'
      )
    ).resolves.toMatchObject({
      state: 'unverifiable',
      mutation: { requestId: 'release_request_1', replayed: false }
    })
    expect(db.getMutationReceipt('remote_home', 'release_request_1')?.state).toBe('pending')
    db.close()

    db = new OrchestrationDb(databasePath)
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const recoveredInvoke = vi.fn(() => ({
      state: 'released',
      processAction: 'closed_agent_terminal'
    }))
    const executor = new OrchestrationMutationExecutor(runtime)

    await expect(
      executor.run(request, request.params, recoveredInvoke, 'remote_home')
    ).resolves.toMatchObject({
      state: 'released',
      mutation: { requestId: 'release_request_1', replayed: true }
    })
    await expect(
      executor.run(request, request.params, vi.fn(), 'remote_home')
    ).resolves.toMatchObject({ state: 'released' })
    expect(recoveredInvoke).toHaveBeenCalledOnce()
    await expect(
      executor.run(
        { ...request, params: { dispatchId: 'different_dispatch' } },
        { dispatchId: 'different_dispatch' },
        vi.fn(),
        'remote_home'
      )
    ).rejects.toMatchObject({ code: 'request_mismatch' })
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('completes an unverifiable local worker release without re-entering effects', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const executor = new OrchestrationMutationExecutor(runtime)
    const request: RpcRequest = {
      id: 'rpc_local_release',
      method: 'orchestration.workerRelease',
      params: { dispatch: 'local_dispatch' },
      orchestrationRequestId: 'local_release_request'
    } as RpcRequest
    const invoke = vi.fn(() => ({ state: 'unverifiable', processAction: 'none' }))

    await expect(
      executor.run(request, request.params, invoke, 'local_caller')
    ).resolves.toMatchObject({ mutation: { replayed: false } })
    await expect(
      executor.run(request, request.params, invoke, 'local_caller')
    ).resolves.toMatchObject({ mutation: { replayed: true } })
    expect(invoke).toHaveBeenCalledOnce()
    expect(db.getMutationReceipt('local_caller', 'local_release_request')?.state).toBe('completed')
    db.close()
  })
})

const promptParams = {
  terminal: 'term-prompt',
  text: 'retry safely',
  enter: true,
  agentPrompt: true,
  client: { id: 'orca-cli', type: 'desktop' }
} as const

function promptRequest(requestId: string): RpcRequest {
  return {
    id: `rpc-${requestId}`,
    authToken: 'token',
    method: 'terminal.send',
    orchestrationRequestId: requestId,
    params: promptParams
  }
}

function workerStartRequest(method: string, requestId: string, params: unknown): RpcRequest {
  return {
    id: `rpc-${requestId}`,
    authToken: 'token',
    method,
    orchestrationRequestId: requestId,
    params
  }
}

function createHarness() {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const binding = vi.spyOn(runtime, 'getTerminalPromptRequestBinding').mockReturnValue({
    ptyId: 'pty-prompt',
    processIncarnation: 'incarnation-1',
    generation: 1
  })
  // Every handle for this PTY resolves to one pane, so a re-minted handle is the same terminal.
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('window-1:leaf-prompt')
  return {
    db,
    executor: new OrchestrationMutationExecutor(runtime),
    bindTerminal: (next: { generation: number; processIncarnation: string }) => {
      binding.mockReturnValue({ ptyId: 'pty-prompt', ...next })
    }
  }
}

describe('terminal prompt mutation receipt retry boundary', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    vi.restoreAllMocks()
  })

  it.each(['terminal_not_writable', 'terminal_handle_stale', 'request_aborted'])(
    'discards a %s receipt before effects become possible',
    async (errorCode) => {
      const harness = createHarness()
      databases.push(harness.db)
      const requestId = `pre-write-${errorCode}`
      const invoke = vi
        .fn()
        .mockRejectedValueOnce(new Error(errorCode))
        .mockResolvedValueOnce({ send: { accepted: true } })

      await expect(
        harness.executor.run(promptRequest(requestId), promptParams, invoke)
      ).rejects.toThrow(errorCode)
      expect(
        harness.db.getMutationReceipt(
          harness.db.getOrCreateLocalMutationCallerFingerprint(),
          requestId
        )
      ).toBeUndefined()

      await expect(
        harness.executor.run(promptRequest(requestId), promptParams, invoke)
      ).resolves.toMatchObject({ mutation: { replayed: false } })
      expect(invoke).toHaveBeenCalledTimes(2)
    }
  )

  it('keeps a failed receipt after the write boundary becomes ambiguous', async () => {
    const harness = createHarness()
    databases.push(harness.db)
    const invoke = vi.fn((mutation) => {
      mutation?.markEffectPossible()
      throw new Error('terminal_not_writable')
    })

    await expect(
      harness.executor.run(promptRequest('post-write'), promptParams, invoke)
    ).rejects.toThrow('terminal_not_writable')
    await expect(
      harness.executor.run(promptRequest('post-write'), promptParams, invoke)
    ).rejects.toMatchObject({ code: 'operation_unknown' })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('returns the durable receipt when a replay-only observation cannot run', async () => {
    const harness = createHarness()
    databases.push(harness.db)
    const requestId = 'observe-replay-rejected'
    const params = { ...promptParams, waitSubmitMs: 100 }
    const request = { ...promptRequest(requestId), params }
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        send: { prompt: { stages: ['input_accepted'] } }
      })
      .mockRejectedValueOnce(new Error('terminal was parked'))

    await expect(harness.executor.run(request, params, invoke)).resolves.toMatchObject({
      send: { prompt: { stages: ['input_accepted'] } },
      mutation: { replayed: false }
    })
    await expect(harness.executor.run(request, params, invoke)).resolves.toMatchObject({
      send: { prompt: { stages: ['input_accepted'] } },
      mutation: { replayed: true }
    })
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('reports a replay as incarnation_replaced once the PTY generation advances', async () => {
    const harness = createHarness()
    databases.push(harness.db)
    const requestId = 'stale-binding-replay'
    const invoke = vi.fn().mockResolvedValue({
      send: { prompt: { stages: ['input_accepted', 'turn_started'], observation: 'supported' } }
    })

    await expect(
      harness.executor.run(promptRequest(requestId), promptParams, invoke)
    ).resolves.toMatchObject({ send: { prompt: { observation: 'supported' } } })

    harness.bindTerminal({ generation: 2, processIncarnation: 'incarnation-2' })
    await expect(
      harness.executor.run(promptRequest(requestId), promptParams, invoke)
    ).resolves.toMatchObject({
      send: { prompt: { observation: 'incarnation_replaced' } },
      mutation: { replayed: true }
    })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('replays a byte-identical prompt after the handle is re-minted', async () => {
    const harness = createHarness()
    databases.push(harness.db)
    const requestId = 'rebound-handle-replay'
    const invoke = vi.fn().mockResolvedValue({
      send: { prompt: { stages: ['input_accepted', 'turn_started'], observation: 'supported' } }
    })

    await harness.executor.run(promptRequest(requestId), promptParams, invoke)
    const reminted = { ...promptParams, terminal: 'term_00000000-0000-4000-8000-000000000000' }
    const request = { ...promptRequest(requestId), params: reminted }

    await expect(harness.executor.run(request, reminted, invoke)).resolves.toMatchObject({
      send: { prompt: { observation: 'supported' } },
      mutation: { replayed: true }
    })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('keeps an uncheckpointed pending worker_done fenced after restart', async () => {
    const harness = createHarness()
    databases.push(harness.db)
    const params = { type: 'worker_done' }
    const request: RpcRequest = {
      id: 'rpc-uncheckpointed-worker-done',
      authToken: 'token',
      method: 'orchestration.send',
      orchestrationRequestId: 'uncheckpointed-worker-done',
      params
    }
    harness.db.beginMutationReceipt({
      callerFingerprint: harness.db.getOrCreateLocalMutationCallerFingerprint(),
      requestId: 'uncheckpointed-worker-done',
      method: request.method,
      payloadHash: createHash('sha256')
        .update(JSON.stringify({ method: request.method, params }))
        .digest('hex')
    })
    const invoke = vi.fn()

    await expect(harness.executor.run(request, params, invoke)).rejects.toMatchObject({
      code: 'operation_unknown'
    })
    expect(invoke).not.toHaveBeenCalled()
  })
})

describe('worker start mutation coalescing', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    vi.restoreAllMocks()
  })

  it.each(['orchestration.workerStart', 'orchestration.federationAttachStart'])(
    'joins concurrent identical %s calls before durable acceptance',
    async (method) => {
      const harness = createHarness()
      databases.push(harness.db)
      const requestId = `concurrent-${method}`
      const params = { taskId: 'task-1', taskSpec: 'specification' }
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const invoke = vi.fn(
        async (mutation?: { identity: Parameters<OrchestrationDb['beginMutationReceipt']>[0] }) => {
          if (mutation) {
            harness.db.beginMutationReceipt(mutation.identity)
          }
          await gate
          return { accepted: { dispatchId: 'dispatch-1' } }
        }
      )

      const calls = Promise.all([
        harness.executor.run(workerStartRequest(method, requestId, params), params, invoke),
        harness.executor.run(workerStartRequest(method, requestId, params), params, invoke)
      ])
      release()
      const [first, replay] = await calls

      expect(invoke).toHaveBeenCalledOnce()
      expect(first).toMatchObject({
        accepted: { dispatchId: 'dispatch-1' },
        mutation: { requestId, replayed: false }
      })
      expect(replay).toMatchObject({
        accepted: { dispatchId: 'dispatch-1' },
        mutation: { requestId, replayed: true }
      })
    }
  )

  it('fences a concurrent worker start with a different payload', async () => {
    const harness = createHarness()
    databases.push(harness.db)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const invoke = vi.fn(
      async (mutation?: { identity: Parameters<OrchestrationDb['beginMutationReceipt']>[0] }) => {
        if (mutation) {
          harness.db.beginMutationReceipt(mutation.identity)
        }
        await gate
        return { accepted: true }
      }
    )
    const firstParams = { taskId: 'task-1', taskSpec: 'first' }
    const secondParams = { taskId: 'task-1', taskSpec: 'second' }
    const first = harness.executor.run(
      workerStartRequest('orchestration.workerStart', 'payload-mismatch', firstParams),
      firstParams,
      invoke
    )

    await expect(
      harness.executor.run(
        workerStartRequest('orchestration.workerStart', 'payload-mismatch', secondParams),
        secondParams,
        invoke
      )
    ).rejects.toMatchObject({ code: 'request_mismatch' })
    release()
    await first
    expect(invoke).toHaveBeenCalledOnce()
  })
})
