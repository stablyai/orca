import { useState } from 'react'
import {
  MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE,
  MOBILE_DICTATION_PCM_SAMPLE_RATE
} from './mobile-dictation-pending-audio-budget'
import { bytesToBase64 } from './mobile-dictation-session-state'
import { dictationAudioChunkSend } from '../dictation/mobile-dictation-operations'
import { MOBILE_DICTATION_RECONNECT_GRACE_MS } from '../../../src/shared/rpc-contract/speech-params'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { rpcPayloadMember } from '../transport/rpc-reader-payload'
import { waitForRpcClientReconnected } from '../transport/rpc-client-reconnect-wait'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { isLogicalClientSuspendedError } from '../transport/logical-client-suspended-error'
import type {
  DictationCapture,
  DictationCaptureChunk
} from '../platform/dictation-capture-contract'
import type { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'
import type { RpcClient } from '../transport/rpc-client'

type MobileDictationAudioChunkQueue = {
  pendingChunks: Set<Promise<void>>
  pendingAudioBudget: MobileDictationPendingAudioBudget
  isActive: (dictationId: string) => boolean
  failActiveDictation: (dictationId: string, err: unknown) => void
  transcriptSoFar: MobileDictationTranscriptSoFar
}

// Newer hosts report the text so far: shown while speaking, and handed over by a failure instead of dropped.
export class MobileDictationTranscriptSoFar {
  private kept: { dictationId: string; text: string } | null = null

  constructor(private readonly onNote: (text: string) => void = () => {}) {}

  note(dictationId: string, text: string): void {
    this.kept = { dictationId, text }
    this.onNote(text)
  }

  take(dictationId: string): string {
    const kept = this.kept
    this.kept = null
    return kept?.dictationId === dictationId ? kept.text : ''
  }
}

// The text so far as React state, with the instance chunk replies write it through.
export function useMobileDictationTranscriptSoFar() {
  const [text, setText] = useState('')
  const [kept] = useState(() => new MobileDictationTranscriptSoFar(setText))
  return [text, setText, kept] as const
}

// A request refused or still waiting while the connection moved never reached the host; send it again on the new one, within the host's grace.
export async function sendAcrossConnectionMove<T>(
  client: RpcClient,
  send: () => Promise<T>
): Promise<T> {
  try {
    return await send()
  } catch (err) {
    if (isLogicalClientCutoverError(err) && !isRpcDeliveryUnknown(err)) {
      return send()
    }
    if (isLogicalClientSuspendedError(err) && (await waitForReconnect(client))) {
      return send()
    }
    throw err
  }
}

// Every chunk refused during one outage shares a single wait instead of a listener and timer each.
const reconnectWaits = new WeakMap<RpcClient, Promise<boolean>>()

function waitForReconnect(client: RpcClient): Promise<boolean> {
  let wait = reconnectWaits.get(client)
  if (!wait) {
    wait = waitForRpcClientReconnected(client, MOBILE_DICTATION_RECONNECT_GRACE_MS).finally(() =>
      reconnectWaits.delete(client)
    )
    reconnectWaits.set(client, wait)
  }
  return wait
}

export function subscribeMobileDictationAudioChunks(
  capture: Pick<DictationCapture, 'onChunk'>,
  source: {
    getClient: () => RpcClient | null
    getActiveId: () => string | null
    isAccepting: () => boolean
  },
  queue: Omit<MobileDictationAudioChunkQueue, 'isActive'>
): { remove: () => void } {
  // Reuse wiring on the microphone hot path instead of allocating per chunk.
  const chunkQueue = { ...queue, isActive: (id: string) => source.getActiveId() === id }
  return capture.onChunk((chunk) => {
    const client = source.getClient()
    const dictationId = source.getActiveId()
    if (!client || !dictationId || !source.isAccepting()) {
      return
    }
    if (chunk.droppedBytes > 0) {
      // Page capture loss and budget overflow both mean the page fell behind the microphone; report the same error. Native capture never drops here.
      queue.failActiveDictation(
        dictationId,
        new Error(MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE)
      )
      return
    }
    enqueueMobileDictationAudioChunk(client, dictationId, chunk, chunkQueue)
  })
}

export function enqueueMobileDictationAudioChunk(
  client: RpcClient,
  dictationId: string,
  chunk: DictationCaptureChunk,
  queue: MobileDictationAudioChunkQueue
): void {
  const bytes = chunk.data
  const byteLength = bytes.byteLength
  if (!queue.pendingAudioBudget.tryReserve(byteLength)) {
    queue.failActiveDictation(
      dictationId,
      new Error(MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE)
    )
    return
  }
  const params = {
    dictationId,
    audioBase64: bytesToBase64(bytes),
    sampleRate: MOBILE_DICTATION_PCM_SAMPLE_RATE
  }
  const sendChunk = sendAcrossConnectionMove(client, () =>
    // Wait for a reconnect only as long as the host keeps the session; past that, fail and keep the text so far.
    dictationAudioChunkSend.request(client, params, {
      timeoutMs: MOBILE_DICTATION_RECONNECT_GRACE_MS
    })
  )
    .then((reply) => {
      // Only newer hosts send the text, and only when it changed; any other result still acknowledges the chunk.
      const result = dictationAudioChunkSend.interpret(reply)
      const text = result == null ? undefined : rpcPayloadMember(result, 'text')
      if (typeof text === 'string' && queue.isActive(dictationId)) {
        queue.transcriptSoFar.note(dictationId, text)
      }
    })
    .catch((err) => {
      // The host keeps the session through a reconnect; only audio in flight at the drop is lost.
      if (!isRpcDeliveryUnknown(err)) {
        queue.failActiveDictation(dictationId, err)
      }
    })
    .finally(() => {
      if (queue.isActive(dictationId)) {
        queue.pendingAudioBudget.release(byteLength)
      }
      queue.pendingChunks.delete(sendChunk)
    })
  queue.pendingChunks.add(sendChunk)
}
