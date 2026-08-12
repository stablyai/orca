import {
  MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE,
  MOBILE_DICTATION_PCM_SAMPLE_RATE
} from './mobile-dictation-pending-audio-budget'
import { bytesToBase64 } from './mobile-dictation-session-state'
import type { MicrophoneDataEvent } from '@orca/expo-two-way-audio'
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
  event: MicrophoneDataEvent,
  queue: MobileDictationAudioChunkQueue
): void {
  const raw = event.data
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  const byteLength = bytes.byteLength
  if (!queue.pendingAudioBudget.tryReserve(byteLength)) {
    queue.failActiveDictation(
      dictationId,
      new Error(MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE)
    )
    return
  }
  const sendChunk = client
    .sendRequest('speech.dictation.chunk', {
      dictationId,
      audioBase64: bytesToBase64(bytes),
      sampleRate: MOBILE_DICTATION_PCM_SAMPLE_RATE
    })
    .then((response) => {
      if (!response.ok) {
        throw new Error(response.error.message)
      }
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
