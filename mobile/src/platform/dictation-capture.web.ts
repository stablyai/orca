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

/**
 * Web sibling: the page has no microphone, so the shell holds one and the page drains it.
 *
 * Pulled rather than pushed, because the page-facing seam is request/reply by rule and the one
 * shell-to-page push there is belongs to an RPC `subscribe`. A push lane for bytes the page hands
 * straight back to the desktop would be a new frame kind, capability-negotiated, carrying audio
 * that is already in this process.
 *
 * So the shell rings and this drains on a timer, turning replies into the events
 * `dictation-capture.ts` gets from the engine directly. Above the seam neither host is visible: the
 * same state machine, the same budget, the same routing.
 *
 * Every refusal rejects as the `NativeVerbError` the bridge built, with the reason on it — except
 * a read, whose refusal is a capture that is gone and reaches the interruption lane instead,
 * because that is the state it is and the one the flow already knows how to leave.
 */

/** One read takes the whole ring: the shell bounds what it holds, so a smaller ask would leave
 *  audio behind for no gain and a larger one is refused by the verb's own schema. */
const READ_MAX_BYTES = BRIDGE_AUDIO_RING_MAX_BYTES

/**
 * The shell's reply back into the bytes a chunk carries.
 *
 * The sender encodes them again on the way to the desktop, which is a decode and an encode of
 * 32 KB a second inside one process — the price of one chunk shape rather than two, and of a
 * pending-audio budget that counts the same raw bytes on both hosts.
 */
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

/** Split from the hook so a caller can drive it with a client of its own; the hook is the wiring. */
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
    // Before the handlers, so a handler that ends the capture finds the drain already stopped.
    stopDraining()
    for (const handler of interruptionHandlers) {
      handler()
    }
  }

  /** Nothing for an interval the microphone was silent through: an empty chunk is audio the page
   *  would spend a budget and a send on. */
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
    // The same two kinds the native seam ends on: an `ended` on its own is the OS handing the
    // session back and leaves a live capture alone. `recording` is the shell's own state and ends
    // it whatever the kind — a capture it no longer has is gone however it went.
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
      // A read the shell refused is a capture it no longer has, whatever the code says. The flow
      // above leaves the same way it leaves a phone call, which is the honest answer: there is no
      // microphone, and there will not be one without another start.
      interrupted()
    }
  }

  /**
   * The stop, which brings the tail back with it.
   *
   * Whatever is in the ring when the user lifts the button is up to one interval of what they
   * actually said, and no timer is coming for it — `stopDraining` has just cancelled the one that
   * was. The shell drains it into the stop's own reply, so there is no read to order against the
   * stop, no flight to latch and nothing for an interruption to re-enter: a stop reply carries no
   * interruption, and a second end reaches a shell with no capture and is answered with nothing.
   *
   * Never rejects, which the contract promises: a capture that will not end is not the page's to
   * fix, and every caller reaches this inside a synchronous try that could not see a rejection.
   */
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
      // The shell began capturing inside `start`; this is the page's half, which is the drain.
      stopDraining()
      timer = setInterval(() => {
        // Unguarded: replies cross one lane in the order the shell posted them, so a read that
        // outlives its interval is followed by its successor and never overtaken by one.
        void readOnce()
      }, drainIntervalMs)
      return true
    },
    end: endCapture,
    // The tail is dropped rather than delivered: a release is the screen going away, and there is
    // nobody left to hand it to. The shell sweeps the ring with the capture.
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
