import { describe, expect, it } from 'vitest'
import { handleMockSpeechRequest } from './mock-server-speech-handlers'
import type { RpcResponse } from './mock-server-rpc-handlers'

const success = (id: string, result: unknown): RpcResponse => ({
  id,
  ok: true,
  result,
  _meta: { runtimeId: 'mock-runtime' }
})
const error = (id: string, code: string, message: string): RpcResponse => ({
  id,
  ok: false,
  error: { code, message },
  _meta: { runtimeId: 'mock-runtime' }
})

function call(method: string, params: Record<string, unknown> = {}): RpcResponse {
  let reply: RpcResponse | null = null
  const owned = handleMockSpeechRequest(
    { id: method, method, params },
    (response) => {
      reply = response
    },
    success,
    error
  )
  expect(owned).toBe(true)
  if (!reply) {
    throw new Error(`${method} did not answer`)
  }
  return reply
}

function resultOf(reply: RpcResponse): Record<string, unknown> {
  const result = reply.result
  if (typeof result !== 'object' || result === null) {
    throw new Error('expected an object result')
  }
  return Object.fromEntries(Object.entries(result))
}

// One second of 16 kHz PCM16, base64-encoded.
const ONE_SECOND = 'A'.repeat(Math.ceil(32_000 / 3) * 4)

describe('mock server speech handlers', () => {
  it('keeps speech.models.list to local and OpenAI rows', () => {
    const models = resultOf(call('speech.models.list')).models
    expect(Array.isArray(models)).toBe(true)
    const providers = new Set(
      (Array.isArray(models) ? models : []).map((model: { provider: string }) => model.provider)
    )
    expect([...providers].sort()).toEqual(['local', 'openai'])
  })

  it('lists on-device first, then every cloud provider', () => {
    const providers = resultOf(call('speech.providers.list')).providers
    const ids = (Array.isArray(providers) ? providers : []).map((p: { id: string }) => p.id)
    expect(ids[0]).toBe('local')
    expect(ids).toContain('soniox')
    expect(ids).toContain('mistral')
  })

  it('rejects a bad key and stores only a hint of a good one', () => {
    expect(call('speech.providers.saveKey', { providerId: 'groq', apiKey: 'bad' }).ok).toBe(false)
    const saved = call('speech.providers.saveKey', { providerId: 'groq', apiKey: 'gsk_live_1234' })
    expect(JSON.stringify(saved)).toContain('…1234')
    expect(JSON.stringify(saved)).not.toContain('gsk_live_1234')
    expect(resultOf(call('speech.providers.testKey', { providerId: 'groq' })).ok).toBe(true)
    call('speech.providers.clearKey', { providerId: 'groq' })
    expect(resultOf(call('speech.providers.testKey', { providerId: 'groq' })).ok).toBe(false)
  })

  it('grows the live caption with each realtime chunk and finishes with the transcript', () => {
    call('speech.dictation.setup', { modelId: 'soniox-stt-rt-v5', enabled: true })
    expect(call('speech.dictation.start', { dictationId: 'd1' }).ok).toBe(true)
    const first = resultOf(
      call('speech.dictation.chunk', { dictationId: 'd1', audioBase64: ONE_SECOND })
    )
    const second = resultOf(
      call('speech.dictation.chunk', { dictationId: 'd1', audioBase64: ONE_SECOND })
    )
    expect(first.caption).toEqual({ text: expect.any(String), revision: 1 })
    expect(second.caption).toEqual({ text: expect.any(String), revision: 2 })
    const finished = resultOf(call('speech.dictation.finish', { dictationId: 'd1' }))
    expect(typeof finished.text).toBe('string')
    expect(String(finished.text).length).toBeGreaterThan(0)
  })
})
