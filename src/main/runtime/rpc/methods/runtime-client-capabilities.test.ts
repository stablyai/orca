import { describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { RUNTIME_CLIENT_CAPABILITY_METHODS } from './runtime-client-capabilities'

function makeRequest(params: unknown): RpcRequest {
  return {
    id: 'req-1',
    authToken: 'tok',
    method: 'runtime.clientCapabilities.update',
    params
  }
}

function dispatcher(): RpcDispatcher {
  return new RpcDispatcher({
    runtime: { getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService,
    methods: RUNTIME_CLIENT_CAPABILITY_METHODS
  })
}

describe('runtime.clientCapabilities.update', () => {
  it('updates the authenticated socket capability set after auth', async () => {
    const updateClientCapabilities = vi.fn()

    const response = await dispatcher().dispatch(
      makeRequest({
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }),
      { clientKind: 'mobile', updateClientCapabilities }
    )

    expect(response).toMatchObject({
      ok: true,
      result: { clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY] }
    })
    expect(updateClientCapabilities).toHaveBeenCalledWith([
      STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
    ])
  })

  it('rejects malformed upgrades without mutating authenticated state', async () => {
    const updateClientCapabilities = vi.fn()

    const response = await dispatcher().dispatch(
      makeRequest({
        clientCapabilities: [42]
      }),
      { clientKind: 'mobile', updateClientCapabilities }
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(updateClientCapabilities).not.toHaveBeenCalled()
  })

  it('fails closed when a transport has no post-auth updater', async () => {
    const response = await dispatcher().dispatch(
      makeRequest({
        clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
      }),
      { clientKind: 'runtime' }
    )

    expect(response).toMatchObject({
      ok: false,
      error: { message: 'client_capabilities_update_unsupported' }
    })
  })
})
