import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import type { RpcRequest } from './core'
import { OrchestrationMutationExecutor } from './orchestration-mutation-executor'

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
