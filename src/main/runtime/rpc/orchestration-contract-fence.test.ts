import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/protocol-version'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { defineMethod, type RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'

describe('orchestration contract fence', () => {
  const databases: OrchestrationDb[] = []

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close()
    }
  })

  function createHarness(method = 'orchestration.send') {
    const database = new OrchestrationDb(':memory:')
    databases.push(database)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(database)
    const effect = vi.fn(() => ({ accepted: true }))
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [
        defineMethod({
          name: method,
          params: z.object({ subject: z.string() }),
          handler: effect
        })
      ]
    })
    return { database, dispatcher, effect }
  }

  function request(overrides: Partial<RpcRequest> = {}): RpcRequest {
    return {
      id: 'rpc_1',
      authToken: 'caller-token',
      method: 'orchestration.send',
      params: { subject: 'hello' },
      orchestrationRequestId: 'mutation_1',
      ...overrides
    }
  }

  it.each([
    [undefined, 'client_contract_missing'],
    [0, 'client_contract_unsupported'],
    [ORCHESTRATION_CONTRACT_VERSION + 1, 'client_contract_unsupported']
  ])(
    'rejects contract version %s before parsing, receipts, or effects',
    async (version, reason) => {
      const { database, dispatcher, effect } = createHarness()
      const response = await dispatcher.dispatch(
        request({
          params: { malformed: true },
          orchestrationContractVersion: version
        })
      )

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'orchestration_migration_required',
          data: {
            reason,
            effectsApplied: false,
            nextCommandArgs: ['skills', 'get', 'orchestration', '--full']
          }
        }
      })
      expect(effect).not.toHaveBeenCalled()
      const callerFingerprint = database.getOrCreateLocalMutationCallerFingerprint()
      expect(database.getMutationReceipt(callerFingerprint, 'mutation_1')).toBeUndefined()
    }
  )

  it('allows the current contract to reach the mutation executor', async () => {
    const { dispatcher, effect } = createHarness()
    const response = await dispatcher.dispatch(
      request({ orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION })
    )

    expect(response).toMatchObject({ ok: true, result: { accepted: true } })
    expect(effect).toHaveBeenCalledOnce()
  })

  it('keeps read-only orchestration inspection available without a contract', async () => {
    const { dispatcher, effect } = createHarness('orchestration.taskList')
    const response = await dispatcher.dispatch(
      request({
        method: 'orchestration.taskList',
        params: { subject: 'read' },
        orchestrationRequestId: undefined
      })
    )

    expect(response).toMatchObject({ ok: true, result: { accepted: true } })
    expect(effect).toHaveBeenCalledOnce()
  })

  it.each(['orchestration.run', 'orchestration.runStop'])(
    'retires %s even when the caller sends the current contract',
    async (method) => {
      const { dispatcher, effect } = createHarness(method)
      const response = await dispatcher.dispatch(
        request({
          method,
          orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION
        })
      )

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'orchestration_migration_required',
          data: { reason: 'command_retired', effectsApplied: false }
        }
      })
      expect(effect).not.toHaveBeenCalled()
    }
  )

  it('applies the same pre-effect fence on WebSocket dispatch', async () => {
    const { dispatcher, effect } = createHarness()
    const replies: string[] = []
    await dispatcher.dispatchStreaming(request(), (reply) => replies.push(reply))

    expect(JSON.parse(replies[0] ?? '{}')).toMatchObject({
      ok: false,
      error: { code: 'orchestration_migration_required' }
    })
    expect(effect).not.toHaveBeenCalled()
  })
})
