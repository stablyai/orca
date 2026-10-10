import { describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import {
  fetchSpeechProviders,
  saveSpeechProviderKey,
  testSpeechProviderKey
} from './mobile-speech-providers'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))

const state = { enabled: true, selectedModelId: 'x', language: 'auto', providers: [] }

describe('speech provider sends', () => {
  it('reads the cabinet from speech.providers.list', async () => {
    const client = createFakeRpcClient()
    const pending = fetchSpeechProviders(client)
    await Promise.resolve()
    expect(client.requests[0]?.args).toEqual(['speech.providers.list', null])
    client.requests.shift()?.resolve({ id: 'r', ok: true, result: state })
    await expect(pending).resolves.toEqual(state)
  })

  it.each([
    ['forbidden', "Method 'speech.providers.list' is not available to mobile clients"],
    ['method_not_found', 'Unknown method']
  ])('answers null for a desktop that predates the cabinet (%s)', async (code, message) => {
    const client = createFakeRpcClient()
    const pending = fetchSpeechProviders(client)
    await Promise.resolve()
    client.requests.shift()?.resolve({ id: 'r', ok: false, error: { code, message } })
    await expect(pending).resolves.toBeNull()
  })

  it('surfaces any other refusal', async () => {
    const client = createFakeRpcClient()
    const pending = fetchSpeechProviders(client)
    await Promise.resolve()
    client.requests
      .shift()
      ?.resolve({ id: 'r', ok: false, error: { code: 'internal_error', message: 'boom' } })
    await expect(pending).rejects.toThrow('boom')
  })

  it('always asks the host to verify a key before saving it', async () => {
    const client = createFakeRpcClient()
    const pending = saveSpeechProviderKey(client, 'soniox', 'secret')
    await Promise.resolve()
    expect(client.requests[0]?.args).toEqual([
      'speech.providers.saveKey',
      { providerId: 'soniox', apiKey: 'secret', verify: true }
    ])
    client.requests.shift()?.resolve({
      id: 'r',
      ok: false,
      error: { code: 'internal_error', message: 'Soniox rejected this API key (401).' }
    })
    await expect(pending).rejects.toThrow('Soniox rejected this API key (401).')
  })

  it('reads a key test verdict', async () => {
    const client = createFakeRpcClient()
    const pending = testSpeechProviderKey(client, 'groq')
    await Promise.resolve()
    client.requests.shift()?.resolve({ id: 'r', ok: true, result: { ok: true, message: null } })
    await expect(pending).resolves.toEqual({ ok: true, message: null })
  })
})
