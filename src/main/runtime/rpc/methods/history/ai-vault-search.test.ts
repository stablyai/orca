import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../../shared/ai-vault/contracts/ai-vault-types'
import { RpcDispatcher } from '../../dispatcher'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { AI_VAULT_METHODS } from './ai-vault'
import '../../../../../shared/ai-vault/search/ai-vault-search-test-fixture'
import '../../../../../shared/ai-vault/search/ai-vault-search-client'
import { setSessionSearchService } from '../../../../ai-vault-search/session-search-service-registry'

afterEach(() => setSessionSearchService(null))

describe('session search consent over the runtime RPC', () => {
  const enableRequest = (params: unknown) => ({
    id: 'enable-1',
    authToken: 'test',
    method: 'aiVault.setSearchEnabled',
    params
  })

  function consentDispatcher(runtime = new OrcaRuntimeService()) {
    const setSessionSearchEnabled = vi.fn(async () => {})
    Object.assign(runtime, { setSessionSearchEnabled })
    const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
    // Streaming dispatch supplies pairedDeviceId, matching the paired WebSocket path.
    const call = async (
      params: unknown,
      options?: { pairedDeviceId?: string; clientKind?: 'runtime' | 'mobile' }
    ): Promise<{ ok: boolean; result?: unknown; error?: { code: string } }> => {
      let raw = ''
      await dispatcher.dispatchStreaming(
        enableRequest(params),
        (response) => {
          raw = response
        },
        options
      )
      return JSON.parse(raw)
    }
    return { setSessionSearchEnabled, call }
  }

  it('refuses an in-process caller and never touches the setting', async () => {
    const { call, setSessionSearchEnabled } = consentDispatcher()
    expect(await call({ enabled: true })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' }
    })
    expect(setSessionSearchEnabled).not.toHaveBeenCalled()
  })

  it('reports the host refusal when this runtime has no settings store', async () => {
    const runtime = new OrcaRuntimeService()
    const dispatcher = new RpcDispatcher({ runtime, methods: AI_VAULT_METHODS })
    let raw = ''
    await dispatcher.dispatchStreaming(
      enableRequest({ enabled: true }),
      (response) => {
        raw = response
      },
      { pairedDeviceId: 'device-7', clientKind: 'runtime' }
    )
    expect(JSON.parse(raw)).toMatchObject({
      ok: false,
      error: { code: 'runtime_unavailable' }
    })
  })
})
