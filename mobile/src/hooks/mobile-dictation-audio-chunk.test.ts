import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { enqueueMobileDictationAudioChunk } from './mobile-dictation-audio-chunk'
import { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'

describe('enqueueMobileDictationAudioChunk', () => {
  it('forwards the native capture rate and falls back for older native events', async () => {
    const sendRequest = vi.fn(async () => ({
      id: 'rpc',
      ok: true as const,
      result: {},
      _meta: { runtimeId: 'runtime' }
    }))
    const queue = {
      pendingChunks: new Set<Promise<void>>(),
      pendingAudioBudget: new MobileDictationPendingAudioBudget(),
      shouldReleaseBudget: () => true,
      failActiveDictation: vi.fn()
    }
    const client = { sendRequest } as unknown as RpcClient

    enqueueMobileDictationAudioChunk(
      client,
      'native-rate',
      { data: new Uint8Array([1, 2]), sampleRate: 48_000 },
      queue
    )
    enqueueMobileDictationAudioChunk(
      client,
      'fallback-rate',
      { data: new Uint8Array([3, 4]) },
      queue
    )
    await Promise.all(queue.pendingChunks)

    expect(sendRequest).toHaveBeenNthCalledWith(
      1,
      'speech.dictation.chunk',
      expect.objectContaining({ dictationId: 'native-rate', sampleRate: 48_000 })
    )
    expect(sendRequest).toHaveBeenNthCalledWith(
      2,
      'speech.dictation.chunk',
      expect.objectContaining({ dictationId: 'fallback-rate', sampleRate: 16_000 })
    )
  })
})
