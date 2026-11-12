import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import '../../../orchestration/db/contract-constants'
import '../../../orchestration/db/messages/mailbox-routing-page'
import '../../../orchestration/db/dispatch-row-writer'
import '../../../orchestration/db/attempt-outcome-projection'
import type { RpcRequest } from '../../core'
import { defineOrchestrationMethod } from '../../methods/orchestration/access/orchestration-method-access'
import { RpcDispatcher } from '../../dispatcher'
import { ORCHESTRATION_METHODS } from '../../methods/orchestration/orchestration'
import { createRootDispatch } from '../../../orchestration/db/root-dispatch-test-fixture'

describe('durable orchestration mutation ledger', () => {
  const paths: string[] = []

  afterEach(() => {
    for (const path of paths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('returns the accepted Dispatch when worker-start was interrupted by restart', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const params = {
      from: 'term_coord',
      task: db.createTask({ runId: 'run_legacy_local', spec: 'restart' }).id
    }
    const callerFingerprint = db.getOrCreateLocalMutationCallerFingerprint()
    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ method: 'orchestration.workerStart', params }))
      .digest('hex')
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: params.task,
      startOptions: {},
      mutationReceipt: {
        callerFingerprint,
        requestId: 'mutation_worker_start',
        method: 'orchestration.workerStart',
        payloadHash
      }
    })
    const effect = vi.fn()
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [
        defineOrchestrationMethod({
          name: 'orchestration.workerStart',
          permission: 'workspace',
          access: { kind: 'writes', targets: {} },
          params: z.object({ from: z.string(), task: z.string() }),
          handler: effect
        })
      ]
    })

    const result = await dispatcher.dispatch({
      id: 'rpc_worker_start_retry',
      authToken: 'caller-token',
      method: 'orchestration.workerStart',
      params,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'mutation_worker_start'
    })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'operation_unknown',
        data: {
          requestId: 'mutation_worker_start',
          dispatchId: started.dispatch.id,
          recoveryCommand: `orca orchestration worker-show --dispatch ${started.dispatch.id} --json`
        }
      }
    })
    expect(effect).not.toHaveBeenCalled()
    db.close()
  })

  it('recovers a lost ask acceptance without creating a second question', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-mutation-ask-recovery-'))
    paths.push(dir)
    const dbPath = join(dir, 'orchestration.db')
    const db = new OrchestrationDb(dbPath)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime:pty:1')
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
    vi.spyOn(runtime, 'waitForMessage').mockImplementation(
      async (_address, options) =>
        await new Promise<'cancelled'>((resolve) => {
          options?.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true })
        })
    )
    const run = db.createRun({
      objective: 'Ask recovery',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })
    const task = db.createTask({ spec: 'ask', runId: run.id })
    createRootDispatch(
      db,
      task.id,
      'term_worker',
      'tab_worker:leaf_worker',
      undefined,
      'runtime:pty:1'
    )
    const askRequest: RpcRequest = {
      id: 'rpc_ask_1',
      authToken: 'caller-token',
      method: 'orchestration.ask',
      params: { from: 'term_worker', question: 'Proceed?', timeoutMs: 60_000 },
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'mutation_ask'
    }
    const controller = new AbortController()
    const firstDispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_METHODS })
    const first = firstDispatcher.dispatch(askRequest, { signal: controller.signal })
    await vi.waitFor(() => expect(db.getInbox(10)).toHaveLength(1))

    const restartedDb = new OrchestrationDb(dbPath)
    const restartedRuntime = new OrcaRuntimeService()
    restartedRuntime.setOrchestrationDb(restartedDb)
    vi.spyOn(restartedRuntime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
    vi.spyOn(restartedRuntime, 'getTerminalProcessIncarnation').mockReturnValue('runtime:pty:1')
    vi.spyOn(restartedRuntime, 'notifyMessageArrived').mockImplementation(() => {})
    const restartedDispatcher = new RpcDispatcher({
      runtime: restartedRuntime,
      methods: ORCHESTRATION_METHODS
    })
    const recovered = await restartedDispatcher.dispatch({ ...askRequest, id: 'rpc_ask_2' })
    expect(recovered).toMatchObject({
      ok: true,
      result: {
        accepted: true,
        messageId: expect.stringMatching(/^msg_/),
        mutation: { requestId: 'mutation_ask', replayed: true }
      }
    })
    expect(db.getInbox(10)).toHaveLength(1)

    controller.abort()
    await first
    restartedDb.close()
    db.close()
  })
})
