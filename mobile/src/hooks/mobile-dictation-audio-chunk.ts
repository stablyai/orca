import { useState } from 'react'
import {
  MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE,
  MOBILE_DICTATION_PCM_SAMPLE_RATE
} from './mobile-dictation-pending-audio-budget'
import { bytesToBase64 } from './mobile-dictation-session-state'
import { dictationAudioChunkSend } from '../dictation/mobile-dictation-operations'
import { MOBILE_DICTATION_RECONNECT_GRACE_MS } from '../../../src/shared/rpc-contract/speech-params'
import { isRpcDeliveryUnknown } from '../transport/rpc/rpc-delivery-ambiguity'
import { rpcPayloadMember } from '../transport/rpc/rpc-reader-payload'
import { waitForRpcClientReconnected } from '../transport/rpc/rpc-client-reconnect-wait'
import { probeLivenessWhileWaiting } from '../transport/rpc/rpc-liveness-probe-while-waiting'
import '../transport/connection/stable-logical-rpc-client'
import { isLogicalClientCutoverError } from '../transport/connection/logical-client-cutover-error'
import { isLogicalClientSuspendedError } from '../transport/connection/logical-client-suspended-error'
import type {
  DictationCapture,
  DictationCaptureChunk
} from '../platform/dictation-capture-contract'
import type { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'
import type { MobileDictationHeldAudio } from './mobile-dictation-held-audio'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

type MobileDictationAudioChunkQueue = {
  // One promise per busy send slot; each settles once nothing is left to send.
  pendingChunks: Set<Promise<void>>
  pendingAudioBudget: MobileDictationPendingAudioBudget
  heldAudio: MobileDictationHeldAudio
  isActive: (dictationId: string) => boolean
  failActiveDictation: (dictationId: string, err: unknown) => void
  transcriptSoFar: MobileDictationTranscriptSoFar
}

// Holding: the microphone runs from the tap while the host's start reply is pending, or for a whole on-device dictation.
export type MobileDictationAudioPhase = 'closed' | 'holding' | 'sending'

// Newer hosts report the text so far: shown while speaking, and handed over by a failure instead of dropped.
export class MobileDictationTranscriptSoFar {
  private kept: { dictationId: string; text: string; revision: number } | null = null

  constructor(private readonly onNote: (text: string) => void = () => {}) {}

  // Several chunk replies can be in flight; hosts that number their text let an older reply arrive last without undoing words.
  note(dictationId: string, text: string, revision = Number.POSITIVE_INFINITY): void {
    const kept = this.kept
    if (kept?.dictationId === dictationId && revision < kept.revision) {
      return
    }
    this.kept = { dictationId, text, revision }
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
// With resendWhile the host dedupes, so a request whose reply a drop lost goes again after each reconnect too, while it still holds.
export async function sendAcrossConnectionMove<T>(
  client: RpcClient,
  send: () => Promise<T>,
  resendWhile?: () => boolean
): Promise<T> {
  const again = () => (resendWhile ? sendAcrossConnectionMove(client, send, resendWhile) : send())
  try {
    return await send()
  } catch (err) {
    if (isLogicalClientCutoverError(err) && !isRpcDeliveryUnknown(err)) {
      return again()
    }
    // A timeout on a connection still up gets no second try there; a reply lost to a drop does.
    const lostToDrop = isLogicalClientCutoverError(err) || client.getState() !== 'connected'
    const resend =
      isLogicalClientSuspendedError(err) ||
      (resendWhile !== undefined && isRpcDeliveryUnknown(err) && lostToDrop)
    if (resend && (await waitForReconnect(client)) && (resendWhile?.() ?? true)) {
      return again()
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
    audioPhase: () => MobileDictationAudioPhase
  },
  queue: Omit<MobileDictationAudioChunkQueue, 'isActive'>
): { remove: () => void; sendHeld: () => void } {
  // Reuse wiring on the microphone hot path instead of allocating per chunk.
  const chunkQueue = { ...queue, isActive: (id: string) => source.getActiveId() === id }
  const send = (client: RpcClient, dictationId: string, chunk: DictationCaptureChunk) => {
    if (chunk.droppedBytes > 0) {
      // Page capture loss and budget overflow both mean the page fell behind the microphone; report the same error. Native capture never drops here.
      queue.failActiveDictation(
        dictationId,
        new Error(MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE)
      )
      return
    }
    enqueueMobileDictationAudioChunk(client, dictationId, chunk, chunkQueue)
  }
  const subscription = capture.onChunk((chunk) => {
    const dictationId = source.getActiveId()
    const phase = source.audioPhase()
    if (!dictationId || phase === 'closed') {
      return
    }
    // An on-device dictation holds its audio with no computer at all.
    if (phase === 'holding') {
      queue.heldAudio.hold(chunk)
      return
    }
    const client = source.getClient()
    if (client) {
      send(client, dictationId, chunk)
    }
  })
  return {
    remove: () => subscription.remove(),
    // Call once the phase turns to sending, before any later chunk, so the seq order matches speech order.
    // Held audio is sent first through the normal slots; it may be a long on-device dictation's replay, so it never counts as falling behind.
    sendHeld: () => {
      const client = source.getClient()
      const dictationId = source.getActiveId()
      if (!client || !dictationId) {
        return
      }
      if (queue.heldAudio.droppedBytes > 0) {
        queue.failActiveDictation(
          dictationId,
          new Error(MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE)
        )
        return
      }
      queue.pendingAudioBudget.reserveBacklog(queue.heldAudio.bytes)
      fillSendSlots(client, dictationId, chunkQueue)
    }
  }
}

// Each chunk RPC holds one of the page bridge's desktop request slots until it settles, through a reconnect too; audio captured while all are busy rides in the next request.
export const MOBILE_DICTATION_MAX_CHUNK_SENDS_IN_FLIGHT = 4

export function enqueueMobileDictationAudioChunk(
  client: RpcClient,
  dictationId: string,
  chunk: DictationCaptureChunk,
  queue: MobileDictationAudioChunkQueue
): void {
  if (!queue.pendingAudioBudget.tryReserve(chunk.data.byteLength)) {
    queue.failActiveDictation(
      dictationId,
      new Error(MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE)
    )
    return
  }
  queue.heldAudio.hold(chunk)
  fillSendSlots(client, dictationId, queue)
}

function fillSendSlots(
  client: RpcClient,
  dictationId: string,
  queue: MobileDictationAudioChunkQueue
): void {
  while (
    queue.pendingChunks.size < MOBILE_DICTATION_MAX_CHUNK_SENDS_IN_FLIGHT &&
    queue.heldAudio.bytes > 0
  ) {
    const slot = sendHeldAudio(client, dictationId, queue).finally(() => {
      queue.pendingChunks.delete(slot)
    })
    queue.pendingChunks.add(slot)
  }
}

// Finish awaits these slots, so a slot keeps sending until nothing is held.
async function sendHeldAudio(
  client: RpcClient,
  dictationId: string,
  queue: MobileDictationAudioChunkQueue
): Promise<void> {
  // Check before taking: after a cancel, held audio may already belong to the next dictation.
  while (queue.isActive(dictationId)) {
    const chunk = queue.heldAudio.takeNext()
    if (!chunk) {
      return
    }
    const backlogShare = queue.pendingAudioBudget.takeBacklog(chunk.data.byteLength)
    await sendAudioChunk(client, dictationId, chunk.data, backlogShare, queue)
  }
}

async function sendAudioChunk(
  client: RpcClient,
  dictationId: string,
  bytes: Uint8Array,
  backlogShare: number,
  queue: MobileDictationAudioChunkQueue
): Promise<void> {
  const params = {
    dictationId,
    audioBase64: bytesToBase64(bytes),
    sampleRate: MOBILE_DICTATION_PCM_SAMPLE_RATE,
    seq: queue.pendingAudioBudget.nextSeq()
  }
  const hostDedupesResends = queue.pendingAudioBudget.hostDedupesResends
  try {
    const reply = await sendAcrossConnectionMove(
      client,
      () => {
        // Wait for a reconnect only as long as the host keeps the session; past that, fail and keep the text so far.
        const sent = dictationAudioChunkSend.request(client, params, {
          timeoutMs: MOBILE_DICTATION_RECONNECT_GRACE_MS
        })
        return hostDedupesResends ? probeLivenessWhileWaiting(client, sent) : sent
      },
      // A recording cancelled during the outage must not reach the host when it comes back.
      hostDedupesResends ? () => queue.isActive(dictationId) : undefined
    )
    // Only newer hosts send the text, and only when it changed; any other result still acknowledges the chunk.
    const result = dictationAudioChunkSend.interpret(reply)
    const text = result == null ? undefined : rpcPayloadMember(result, 'text')
    const revision = result == null ? undefined : rpcPayloadMember(result, 'revision')
    if (typeof text === 'string' && queue.isActive(dictationId)) {
      queue.transcriptSoFar.note(
        dictationId,
        text,
        typeof revision === 'number' ? revision : undefined
      )
    }
  } catch (err) {
    // A host that cannot dedupe loses only the audio in flight at a drop; for one that dedupes, still being offline here means the reconnect grace ran out and later held audio would wait it out again.
    const graceExpired = hostDedupesResends && client.getState() !== 'connected'
    if (!isRpcDeliveryUnknown(err) || graceExpired) {
      queue.failActiveDictation(dictationId, err)
    }
  } finally {
    if (queue.isActive(dictationId)) {
      queue.pendingAudioBudget.release(bytes.byteLength, backlogShare)
    }
  }
}
