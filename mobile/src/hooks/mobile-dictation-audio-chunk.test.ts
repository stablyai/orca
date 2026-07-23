import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  enqueueMobileDictationAudioChunk,
  MOBILE_DICTATION_MAX_PENDING_CHUNKS
} from './mobile-dictation-audio-chunk'
import { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'

describe('enqueueMobileDictationAudioChunk', () => {
  it('accepts the exact pending-promise cap and rejects one over even for empty chunks', () => {
    const sendRequest = vi.fn(() => new Promise<never>(() => undefined))
    const failActiveDictation = vi.fn()
    const pendingChunks = new Set<Promise<void>>()
    const queue = {
      pendingChunks,
      pendingAudioBudget: new MobileDictationPendingAudioBudget(),
      shouldReleaseBudget: () => true,
      failActiveDictation
    }
    const event = { data: new Uint8Array() }

    for (let index = 0; index < MOBILE_DICTATION_MAX_PENDING_CHUNKS; index += 1) {
      enqueueMobileDictationAudioChunk(
        { sendRequest } as unknown as RpcClient,
        'dictation',
        event,
        queue
      )
    }
    expect(pendingChunks).toHaveLength(MOBILE_DICTATION_MAX_PENDING_CHUNKS)
    expect(failActiveDictation).not.toHaveBeenCalled()

    enqueueMobileDictationAudioChunk(
      { sendRequest } as unknown as RpcClient,
      'dictation',
      event,
      queue
    )
    expect(pendingChunks).toHaveLength(MOBILE_DICTATION_MAX_PENDING_CHUNKS)
    expect(failActiveDictation).toHaveBeenCalledOnce()
  })
})
