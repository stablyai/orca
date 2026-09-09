import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { ResourceEvidence } from '../../../shared/resource-evidence-types'
import { RESOURCE_METHODS } from './resource'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

const evidence: ResourceEvidence = {
  queriedAt: '2026-09-09T12:00:00.000Z',
  providers: {
    codex: {
      available: true,
      status: 'ok',
      sourceUpdatedAt: '2026-09-09T11:52:00.000Z',
      dataAgeMs: 480000,
      rateLimited: false,
      retryAt: null,
      windows: [
        {
          role: 'BURST',
          windowMinutes: 300,
          remainingRatio: 0.81,
          remainingRatioGranularity: 0.01,
          resetAt: '2026-09-09T14:38:00.000Z',
          resetAtSource: 'unknown'
        }
      ]
    }
  }
}

describe('resource RPC methods', () => {
  it('returns the resource evidence projection and defaults refresh to false', async () => {
    const getResourceEvidence = vi.fn().mockResolvedValue(evidence)
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getResourceEvidence
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: RESOURCE_METHODS })

    const response = await dispatcher.dispatch(makeRequest('resource.status'))

    expect(getResourceEvidence).toHaveBeenCalledWith({ refresh: false })
    expect(response).toMatchObject({ ok: true, result: evidence })
  })

  it('passes an explicit refresh through', async () => {
    const getResourceEvidence = vi.fn().mockResolvedValue(evidence)
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getResourceEvidence
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: RESOURCE_METHODS })

    await dispatcher.dispatch(makeRequest('resource.status', { refresh: true }))

    expect(getResourceEvidence).toHaveBeenCalledWith({ refresh: true })
  })

  it('carries no account arrays or identity in the response', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getResourceEvidence: vi.fn().mockResolvedValue(evidence)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: RESOURCE_METHODS })

    const response = await dispatcher.dispatch(makeRequest('resource.status'))
    const serialized = JSON.stringify(response)

    for (const forbidden of ['accounts', 'inactiveClaudeAccounts', 'email', 'accountId']) {
      expect(serialized).not.toContain(forbidden)
    }
  })
})
