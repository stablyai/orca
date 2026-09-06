// A lost mutation response must be answerable without mutating again: these cover
// `orchestration.requestShow` reading the same durable receipt --retry-request replays.
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { defineMethod, type RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { ORCHESTRATION_METHODS } from './methods/orchestration'

// Why: filter the shipped array rather than importing the module, so the test also
// fails if the method exists but was never registered with the orchestration surface.
const REQUEST_SHOW_METHODS = ORCHESTRATION_METHODS.filter(
  (method) => method.name === 'orchestration.requestShow'
)

const Params = z.object({ subject: z.string() })

function createHarness() {
  const db = new OrchestrationDb(':memory:')
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
      }),
      ...REQUEST_SHOW_METHODS
    ]
  })
  return { db, runtime, dispatcher, effect }
}

function sendRequest(mutationId: string): RpcRequest {
  return {
    id: `rpc_${mutationId}`,
    authToken: 'caller-token',
    method: 'orchestration.send',
    params: { subject: 'hello' },
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: mutationId
  }
}

function showRequest(requestId: string): RpcRequest {
  return {
    id: `rpc_show_${requestId}`,
    authToken: 'caller-token',
    method: 'orchestration.requestShow',
    params: { request: requestId },
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
  }
}

describe('orchestration.requestShow', () => {
  it('reports a recorded mutation as completed without repeating its effect', async () => {
    const { dispatcher, effect } = createHarness()
    await dispatcher.dispatch(sendRequest('mutation_completed'))

    const response = await dispatcher.dispatch(showRequest('mutation_completed'))

    expect(response).toMatchObject({
      ok: true,
      result: { requestId: 'mutation_completed', state: 'completed', method: 'orchestration.send' }
    })
    expect(effect).toHaveBeenCalledOnce()
  })

  it('returns the stored receipt so the caller can read the original outcome', async () => {
    const { dispatcher } = createHarness()
    const first = await dispatcher.dispatch(sendRequest('mutation_receipt'))

    const response = await dispatcher.dispatch(showRequest('mutation_receipt'))

    const result = (response as { result: { receipt: { message: { id: string } } } }).result
    const sent = (first as { result: { message: { id: string } } }).result
    expect(result.receipt.message.id).toBe(sent.message.id)
  })

  it('reports an interrupted mutation as pending and names the keyed replay', async () => {
    const { db, dispatcher } = createHarness()
    db.beginMutationReceipt({
      callerFingerprint: db.getOrCreateLocalMutationCallerFingerprint(),
      requestId: 'mutation_pending',
      method: 'orchestration.workerStart',
      payloadHash: 'hash'
    })

    const response = await dispatcher.dispatch(showRequest('mutation_pending'))

    const result = (response as { result: { state: string; interpretation: string } }).result
    expect(result.state).toBe('pending')
    expect(result.interpretation).toContain('--retry-request mutation_pending')
  })

  it('does not claim a concurrently running mutation was interrupted by a restart', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    let finishMutation: (() => void) | undefined
    let reportStarted: (() => void) | undefined
    const mutationFinished = new Promise<void>((resolve) => {
      finishMutation = resolve
    })
    const mutationStarted = new Promise<void>((resolve) => {
      reportStarted = resolve
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [
        defineMethod({
          name: 'orchestration.send',
          params: Params,
          handler: async () => {
            reportStarted?.()
            await mutationFinished
            return { sent: true }
          }
        }),
        ...REQUEST_SHOW_METHODS
      ]
    })

    const runningMutation = dispatcher.dispatch(sendRequest('mutation_running'))
    await mutationStarted

    const response = await dispatcher.dispatch(showRequest('mutation_running'))
    const result = (response as { result: { state: string; interpretation: string } }).result
    expect(result.state).toBe('pending')
    expect(result.interpretation).toContain('may still be running')
    expect(result.interpretation).not.toContain('so Orca restarted')

    finishMutation?.()
    await runningMutation
  })

  it('reports an unknown request as absent without claiming nothing happened', async () => {
    const { dispatcher } = createHarness()

    const response = await dispatcher.dispatch(showRequest('mutation_missing'))

    const result = (response as { result: { state: string; interpretation: string } }).result
    expect(result.state).toBe('absent')
    expect(result.interpretation).toContain('not proof that nothing happened')
  })

  it('scopes receipts to the caller identity that recorded them', async () => {
    const { dispatcher } = createHarness()
    await dispatcher.dispatch(sendRequest('mutation_scoped'))

    const response = await dispatcher.dispatch(showRequest('mutation_scoped'), {
      authenticatedCallerFingerprint: 'some-other-paired-device'
    })

    expect((response as { result: { state: string } }).result.state).toBe('absent')
  })

  it('never records a receipt of its own', async () => {
    const { db, dispatcher } = createHarness()
    const response = await dispatcher.dispatch(showRequest('mutation_readonly'))

    expect(response).toMatchObject({ ok: true })
    expect(
      db.getMutationReceipt(db.getOrCreateLocalMutationCallerFingerprint(), 'mutation_readonly')
    ).toBeUndefined()
  })
})
