import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SPEECH_METHODS } from './speech'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('speech RPC methods', () => {
  it('feeds valid base64 dictation chunks to the runtime', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      feedMobileDictation: vi.fn().mockReturnValue({ dictationId: 'dict-1' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SPEECH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('speech.dictation.chunk', {
        dictationId: 'dict-1',
        audioBase64: 'AAAA',
        sampleRate: 16_000
      })
    )

    expect(response).toMatchObject({ ok: true, result: { dictationId: 'dict-1' } })
    expect(runtime.feedMobileDictation).toHaveBeenCalledWith({
      dictationId: 'dict-1',
      audioBase64: 'AAAA',
      sampleRate: 16_000,
      clientId: undefined,
      connectionId: undefined
    })
  })

  it('rejects malformed base64 dictation chunks before feeding audio', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      feedMobileDictation: vi.fn().mockReturnValue({ dictationId: 'dict-1' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SPEECH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('speech.dictation.chunk', {
        dictationId: 'dict-1',
        audioBase64: '!!!!',
        sampleRate: 16_000
      })
    )

    expect(response).toMatchObject({ ok: false })
    expect(runtime.feedMobileDictation).not.toHaveBeenCalled()
  })
})
