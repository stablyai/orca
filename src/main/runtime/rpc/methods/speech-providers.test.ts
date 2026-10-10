import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SPEECH_METHODS } from './speech'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function createDispatcher(overrides: Record<string, unknown>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Each test stubs only the runtime methods its RPC calls.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    ...overrides
  } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: SPEECH_METHODS })
}

describe('speech provider RPC methods', () => {
  it('lists providers', async () => {
    const listMobileSpeechProviders = vi.fn().mockResolvedValue({ providers: [] })
    const dispatcher = createDispatcher({ listMobileSpeechProviders })

    const response = await dispatcher.dispatch(makeRequest('speech.providers.list'))

    expect(response).toMatchObject({ ok: true, result: { providers: [] } })
  })

  it('forwards a key save with the verify flag', async () => {
    const saveMobileSpeechProviderKey = vi.fn().mockResolvedValue({ providers: [] })
    const dispatcher = createDispatcher({ saveMobileSpeechProviderKey })

    await dispatcher.dispatch(
      makeRequest('speech.providers.saveKey', { providerId: 'soniox', apiKey: 'k', verify: true })
    )

    expect(saveMobileSpeechProviderKey).toHaveBeenCalledWith({
      providerId: 'soniox',
      apiKey: 'k',
      verify: true
    })
  })

  it('rejects a key save without a key before reaching the runtime', async () => {
    const saveMobileSpeechProviderKey = vi.fn()
    const dispatcher = createDispatcher({ saveMobileSpeechProviderKey })

    const response = await dispatcher.dispatch(
      makeRequest('speech.providers.saveKey', { providerId: 'soniox', apiKey: '' })
    )

    expect(response).toMatchObject({ ok: false })
    expect(saveMobileSpeechProviderKey).not.toHaveBeenCalled()
  })

  it('surfaces a rejected key as an RPC error message', async () => {
    const saveMobileSpeechProviderKey = vi
      .fn()
      .mockRejectedValue(new Error('Soniox rejected this API key (401).'))
    const dispatcher = createDispatcher({ saveMobileSpeechProviderKey })

    const response = await dispatcher.dispatch(
      makeRequest('speech.providers.saveKey', { providerId: 'soniox', apiKey: 'bad', verify: true })
    )

    expect(JSON.stringify(response)).toContain('Soniox rejected this API key (401).')
  })

  it('routes clear, test and configure', async () => {
    const clearMobileSpeechProviderKey = vi.fn().mockResolvedValue({ providers: [] })
    const testMobileSpeechProviderKey = vi.fn().mockResolvedValue({ ok: true, message: null })
    const configureMobileSpeechProviders = vi.fn().mockResolvedValue({ language: 'uk' })
    const dispatcher = createDispatcher({
      clearMobileSpeechProviderKey,
      testMobileSpeechProviderKey,
      configureMobileSpeechProviders
    })

    await dispatcher.dispatch(makeRequest('speech.providers.clearKey', { providerId: 'groq' }))
    const test = await dispatcher.dispatch(
      makeRequest('speech.providers.testKey', { providerId: 'groq' })
    )
    await dispatcher.dispatch(makeRequest('speech.providers.configure', { language: 'uk' }))
    await dispatcher.dispatch(makeRequest('speech.providers.configure', {}))

    expect(clearMobileSpeechProviderKey).toHaveBeenCalledWith({ providerId: 'groq' })
    expect(test).toMatchObject({ ok: true, result: { ok: true, message: null } })
    expect(configureMobileSpeechProviders).toHaveBeenNthCalledWith(1, { language: 'uk' })
    expect(configureMobileSpeechProviders).toHaveBeenNthCalledWith(2, {})
  })
})
