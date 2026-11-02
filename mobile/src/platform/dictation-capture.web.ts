import { useMemo } from 'react'
import {
  BRIDGE_AUDIO_RING_MAX_BYTES,
  bridgeAudioInterruptionEndsCapture,
  type BridgeAudioChunk
} from '../mobile-web-shell/bridge/bridge-audio-verbs'
import { useNativeVerbs, type NativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import { MOBILE_DICTATION_PCM_SAMPLE_RATE } from '../hooks/mobile-dictation-pending-audio-budget'
import {
  DICTATION_CAPTURE_DRAIN_INTERVAL_MS,
  type DictationCapture,
  type DictationCaptureChunk,
  type DictationCaptureOpen,
  type DictationCaptureSubscription
} from './dictation-capture-contract'

// Pull shell audio through existing request/reply verbs instead of adding a negotiated push lane. Treat refused reads as capture loss on the existing interruption path.

// Drain the bounded ring whole; smaller reads leave audio behind and larger ones violate the verb schema.
const READ_MAX_BYTES = BRIDGE_AUDIO_RING_MAX_BYTES

// Decode into the shared raw-PCM chunk so both hosts reserve the same budget before wire re-encoding.
function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

type Handlers<Handler> = Set<Handler>

function subscribe<Handler>(
  handlers: Handlers<Handler>,
  handler: Handler
): DictationCaptureSubscription {
  handlers.add(handler)
  return {
    remove: () => {
      handlers.delete(handler)
    }
  }
}

export function createPageDictationCapture(
  verbs: NativeVerbs,
  drainIntervalMs: number = DICTATION_CAPTURE_DRAIN_INTERVAL_MS
): DictationCapture {
  const chunkHandlers: Handlers<(chunk: DictationCaptureChunk) => void> = new Set()
  const interruptionHandlers: Handlers<() => void> = new Set()
  let timer: ReturnType<typeof setInterval> | null = null

  function stopDraining(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function interrupted(): void {
    // Stop before notifying handlers so reentrant end sees no active drain.
    stopDraining()
    for (const handler of interruptionHandlers) {
      handler()
    }
  }

  // Skip empty silent chunks to avoid spending budget/request slots on no audio.
  function deliverBytes(base64: string, droppedBytes: number): void {
    if (base64.length === 0 && droppedBytes === 0) {
      return
    }
    const chunk: DictationCaptureChunk = { data: decodeBase64(base64), droppedBytes }
    for (const handler of chunkHandlers) {
      handler(chunk)
    }
  }

  function deliver(reply: BridgeAudioChunk): void {
    deliverBytes(reply.base64, reply.droppedBytes)
    // Ended alone returns the OS session; began/blocked or recording:false mean capture loss on either host.
    if (
      !reply.recording ||
      (reply.interruption !== null && bridgeAudioInterruptionEndsCapture(reply.interruption))
    ) {
      interrupted()
    }
  }

  async function readOnce(): Promise<void> {
    try {
      deliver(await verbs.readAudio(READ_MAX_BYTES))
    } catch {
      // Treat any refused read as interruption; another explicit start is required to recover capture.
      interrupted()
    }
  }

  // Deliver the final ring tail from stop itself so no extra read can race stop or reenter interruption. Catch refusal because synchronous void cleanup callers cannot catch a rejection.
  async function endCapture(): Promise<void> {
    stopDraining()
    const stopped = await verbs.stopAudio().catch(() => null)
    if (stopped !== null) {
      deliverBytes(stopped.base64, stopped.droppedBytes)
    }
  }

  return {
    open: async (): Promise<DictationCaptureOpen> => {
      const started = await verbs.startAudio(MOBILE_DICTATION_PCM_SAMPLE_RATE)
      if (started.started) {
        return { ok: true }
      }
      return {
        ok: false,
        reason: started.permission === 'granted' ? 'unavailable' : 'permission-denied'
      }
    },
    begin: () => {
      stopDraining()
      timer = setInterval(() => {
        // Allow overlapping reads: reply delivery follows the shell’s posted order on the single lane.
        void readOnce()
      }, drainIntervalMs)
      return true
    },
    end: endCapture,
    // Release discards the tail because its screen is gone; native cleanup still frees the ring/capture.
    release: () => {
      stopDraining()
      void verbs.stopAudio().catch(() => undefined)
    },
    onChunk: (handler) => subscribe(chunkHandlers, handler),
    onInterruption: (handler) => subscribe(interruptionHandlers, handler)
  }
}

export function useDictationCapture(): DictationCapture {
  const verbs = useNativeVerbs()
  return useMemo(() => createPageDictationCapture(verbs), [verbs])
}
