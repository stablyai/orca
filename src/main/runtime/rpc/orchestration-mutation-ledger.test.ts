import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { defineMethod, type RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'

const Params = z.object({ subject: z.string() })

function request(params: {
  rpcId: string
  mutationId: string
  subject: string
  authToken?: string
}): RpcRequest {
  return {
    id: params.rpcId,
    authToken: params.authToken ?? 'caller-token',
    method: 'orchestration.send',
    params: { subject: params.subject },
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: params.mutationId
  }
}

describe('durable orchestration mutation ledger', () => {
  const paths: string[] = []

  afterEach(() => {
    for (const path of paths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  function createHarness(dbPath: (string & {}) | ':memory:' = ':memory:') {
    const db = new OrchestrationDb(dbPath)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const effect = vi.fn((subject: string) =>
      db.insertMessage({ from: 'caller', to: 'recipient', subject })
    )
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [
        defineMethod({
          name: 'orchestration.send',
          params: Params,
          handler: ({ subject }) => ({ message: effect(subject) })
        })
      ]
    })
    return { db, runtime, dispatcher, effect }
  }

  it('replays one completed receipt without repeating the effect', async () => {
    const { db, dispatcher, effect } = createHarness()
    const first = await dispatcher.dispatch(
      request({ rpcId: 'rpc_1', mutationId: 'mutation_1', subject: 'hello' })
    )
    const replay = await dispatcher.dispatch(
      request({ rpcId: 'rpc_2', mutationId: 'mutation_1', subject: 'hello' })
    )

    expect(first).toMatchObject({
      ok: true,
      result: { message: { subject: 'hello' }, mutation: { replayed: false } }
    })
    expect(replay).toMatchObject({
      ok: true,
      result: { message: { subject: 'hello' }, mutation: { replayed: true } }
    })
    expect(effect).toHaveBeenCalledTimes(1)
    expect(db.getInbox(10)).toHaveLength(1)
    db.close()
  })

  it('rejects changed input for the same caller and request ID', async () => {
    const { db, dispatcher } = createHarness()
    await dispatcher.dispatch(
      request({ rpcId: 'rpc_1', mutationId: 'mutation_1', subject: 'hello' })
    )
    const mismatch = await dispatcher.dispatch(
      request({ rpcId: 'rpc_2', mutationId: 'mutation_1', subject: 'changed' })
    )

    expect(mismatch).toMatchObject({ ok: false, error: { code: 'request_mismatch' } })
    db.close()
  })

  it('keys WebSocket replay to the authenticated device across reconnects', async () => {
    const { db, dispatcher, effect } = createHarness()
    const replies: string[] = []
    const firstRequest = request({
      rpcId: 'rpc_1',
      mutationId: 'mutation_remote',
      subject: 'remote'
    }) as RpcRequest & { deviceToken?: string }
    firstRequest.authToken = ''
    firstRequest.deviceToken = 'untrusted-request-value-a'
    await dispatcher.dispatchStreaming(firstRequest, (reply) => replies.push(reply), {
      authenticatedCallerFingerprint: 'paired-device-a'
    })
    const replayRequest = {
      ...firstRequest,
      id: 'rpc_2',
      deviceToken: 'untrusted-request-value-b'
    }
    await dispatcher.dispatchStreaming(replayRequest, (reply) => replies.push(reply), {
      authenticatedCallerFingerprint: 'paired-device-a'
    })
    await dispatcher.dispatchStreaming(
      { ...replayRequest, id: 'rpc_3' },
      (reply) => replies.push(reply),
      { authenticatedCallerFingerprint: 'paired-device-b' }
    )

    expect(JSON.parse(replies[0] ?? '{}')).toMatchObject({
      ok: true,
      result: { mutation: { replayed: false } }
    })
    expect(JSON.parse(replies[1] ?? '{}')).toMatchObject({
      ok: true,
      result: { mutation: { replayed: true } }
    })
    expect(JSON.parse(replies[2] ?? '{}')).toMatchObject({
      ok: true,
      result: { mutation: { replayed: false } }
    })
    expect(effect).toHaveBeenCalledTimes(2)
    expect(db.getInbox(10)).toHaveLength(2)
    db.close()
  })

  it('joins concurrent identical mutations', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const effect = vi.fn(async () => {
      await gate
      return { accepted: true }
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [
        defineMethod({
          name: 'orchestration.send',
          params: Params,
          handler: effect
        })
      ]
    })
    const first = dispatcher.dispatch(
      request({ rpcId: 'rpc_1', mutationId: 'mutation_join', subject: 'same' })
    )
    await Promise.resolve()
    const second = dispatcher.dispatch(
      request({ rpcId: 'rpc_2', mutationId: 'mutation_join', subject: 'same' })
    )
    release?.()

    expect(await first).toMatchObject({ ok: true, result: { mutation: { replayed: false } } })
    expect(await second).toMatchObject({ ok: true, result: { mutation: { replayed: true } } })
    expect(effect).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('replays a completed receipt after database and dispatcher restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-mutation-ledger-'))
    paths.push(dir)
    const dbPath = join(dir, 'orchestration.db')
    const first = createHarness(dbPath)
    await first.dispatcher.dispatch(
      request({ rpcId: 'rpc_1', mutationId: 'mutation_1', subject: 'durable' })
    )
    first.db.close()

    const second = createHarness(dbPath)
    const replay = await second.dispatcher.dispatch(
      request({ rpcId: 'rpc_2', mutationId: 'mutation_1', subject: 'durable' })
    )
    expect(replay).toMatchObject({
      ok: true,
      result: { message: { subject: 'durable' }, mutation: { replayed: true } }
    })
    expect(second.effect).not.toHaveBeenCalled()
    second.db.close()
  })

  it('replays a local mutation after runtime authentication rotates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-mutation-ledger-'))
    paths.push(dir)
    const dbPath = join(dir, 'orchestration.db')
    const firstRuntime = createHarness(dbPath)
    const first = await firstRuntime.dispatcher.dispatch(
      request({
        rpcId: 'rpc_1',
        mutationId: 'mutation_restart',
        subject: 'once',
        authToken: 'before-restart'
      })
    )
    firstRuntime.db.close()

    const restartedRuntime = createHarness(dbPath)
    const replay = await restartedRuntime.dispatcher.dispatch(
      request({
        rpcId: 'rpc_2',
        mutationId: 'mutation_restart',
        subject: 'once',
        authToken: 'after-restart'
      })
    )

    expect(first).toMatchObject({ ok: true, result: { mutation: { replayed: false } } })
    expect(replay).toMatchObject({ ok: true, result: { mutation: { replayed: true } } })
    expect(firstRuntime.effect).toHaveBeenCalledOnce()
    expect(restartedRuntime.effect).not.toHaveBeenCalled()
    restartedRuntime.db.close()
  })

  it('returns unknown for a pending receipt left by a previous process', async () => {
    const { db, dispatcher } = createHarness()
    db.beginMutationReceipt({
      callerFingerprint: db.getOrCreateLocalMutationCallerFingerprint(),
      requestId: 'mutation_1',
      method: 'orchestration.send',
      payloadHash: createHash('sha256')
        .update('{"method":"orchestration.send","params":{"subject":"hello"}}')
        .digest('hex')
    })

    const result = await dispatcher.dispatch(
      request({ rpcId: 'rpc_1', mutationId: 'mutation_1', subject: 'hello' })
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'operation_unknown' } })
    db.close()
  })

  it('resumes a pending idempotent worker release after restart', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const params = { dispatch: 'ctx_release' }
    const callerFingerprint = db.getOrCreateLocalMutationCallerFingerprint()
    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ method: 'orchestration.workerRelease', params }))
      .digest('hex')
    db.beginMutationReceipt({
      callerFingerprint,
      requestId: 'mutation_release',
      method: 'orchestration.workerRelease',
      payloadHash
    })
    const effect = vi.fn().mockReturnValue({ state: 'release_pending' })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [
        defineMethod({
          name: 'orchestration.workerRelease',
          params: z.object({ dispatch: z.string() }),
          handler: effect
        })
      ]
    })

    const result = await dispatcher.dispatch({
      id: 'rpc_release_retry',
      authToken: 'caller-token',
      method: 'orchestration.workerRelease',
      params,
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationRequestId: 'mutation_release'
    })

    expect(result).toMatchObject({
      ok: true,
      result: {
        state: 'release_pending',
        mutation: { requestId: 'mutation_release', replayed: true }
      }
    })
    expect(effect).toHaveBeenCalledTimes(1)
    expect(db.getMutationReceipt(callerFingerprint, 'mutation_release')?.state).toBe('completed')
    db.close()
  })

  it('returns the accepted Dispatch when worker-start was interrupted by restart', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const params = { from: 'term_coord', task: db.createTask({ spec: 'restart' }).id }
    const callerFingerprint = db.getOrCreateLocalMutationCallerFingerprint()
    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ method: 'orchestration.workerStart', params }))
      .digest('hex')
    const started = db.createStartingWorkerDispatch({
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
        defineMethod({
          name: 'orchestration.workerStart',
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
    const dispatch = db.createDispatchContext(task.id, 'term_worker', 'tab_worker:leaf_worker')
    const capability = db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime:pty:1'
    })
    const askRequest: RpcRequest = {
      id: 'rpc_ask_1',
      authToken: 'caller-token',
      method: 'orchestration.ask',
      params: { from: 'term_worker', question: 'Proceed?', timeoutMs: 60_000 },
      orchestrationCapability: capability,
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
