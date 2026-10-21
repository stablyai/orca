import {
  MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE,
  MOBILE_DICTATION_PCM_SAMPLE_RATE
} from './mobile-dictation-pending-audio-budget'
import { bytesToBase64 } from './mobile-dictation-session-state'
import { dictationAudioChunkSend } from '../dictation/mobile-dictation-operations'
import type { DictationCaptureChunk } from '../platform/dictation-capture-contract'
import type { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'
import type { RpcClient } from '../transport/rpc-client'

type MobileDictationAudioChunkQueue = {
  pendingChunks: Set<Promise<void>>
  pendingAudioBudget: MobileDictationPendingAudioBudget
  shouldReleaseBudget: (dictationId: string) => boolean
  failActiveDictation: (dictationId: string, err: unknown) => void
}

export function enqueueMobileDictationAudioChunk(
  client: RpcClient,
  dictationId: string,
  chunk: DictationCaptureChunk,
  queue: MobileDictationAudioChunkQueue
): void {
  // The seam normalises what the engine handed over, so there is nothing to widen here.
  const bytes = chunk.data
  const byteLength = bytes.byteLength
  if (!queue.pendingAudioBudget.tryReserve(byteLength)) {
    queue.failActiveDictation(
      dictationId,
      new Error(MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE)
    )
    return
  }
  const sendChunk = dictationAudioChunkSend
    .request(client, {
      dictationId,
      audioBase64: bytesToBase64(bytes),
      sampleRate: MOBILE_DICTATION_PCM_SAMPLE_RATE
    })
    .then((reply) => {
      dictationAudioChunkSend.interpret(reply)
    })
    .catch((err) => queue.failActiveDictation(dictationId, err))
    .finally(() => {
      if (queue.shouldReleaseBudget(dictationId)) {
        queue.pendingAudioBudget.release(byteLength)
      }
      queue.pendingChunks.delete(sendChunk)
    })
  queue.pendingChunks.add(sendChunk)
}
