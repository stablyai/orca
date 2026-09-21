import {
  BRIDGE_AUDIO_RING_MAX_BYTES,
  bridgeAudioInterruptionEndsCapture,
  audioReadParamsSchema,
  audioStartParamsSchema,
  audioStopParamsSchema,
  type BridgeAudioInterruption,
  type BridgeAudioPermission
} from '../mobile-web-shell/bridge/bridge-audio-verbs'
import type { BridgeNativeVerb } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { BridgeNativeVerbRefusedError } from '../mobile-web-shell/bridge-host-errors'
import { bytesToBase64 } from '../hooks/mobile-dictation-session-state'

/**
 * The device side of `native.audio.start`, `read` and `stop`.
 *
 * The microphone opens here, inside the shell, which is the whole reason these are verbs: a page
 * served from a custom scheme has no `getUserMedia` worth having, and the OS permission prompt is
 * the shell's to run. What crosses back is PCM, because the page is what speaks
 * `speech.dictation.*` to the desktop — transcription runs there, and putting that protocol in the
 * binary would freeze it until a store release.
 *
 * Every engine call is injectable for the reason the media verbs' are: the arms worth pinning — a
 * denied microphone, an engine that will not open, a ring that filled, an interruption — are the
 * ones a simulator makes expensive, and none of them is a fact about Swift.
 */

/** The audio engine as this handler needs it: a permission, an open, a run, and two event lanes. */
export type NativeAudioEngine = {
  /** Runs the OS prompt if the OS runs one, and answers what it decided. */
  readonly requestPermission: () => Promise<BridgeAudioPermission>
  /** Brings the engine up and answers the rate it actually opened at. */
  readonly open: (sampleRate: number) => Promise<{ opened: boolean; sampleRate: number }>
  /** Starts producing microphone events. False is a device that would not. */
  readonly begin: () => boolean
  /** Stops producing them and releases the session. Called on every exit, including a throw. */
  readonly end: () => void
  readonly onMicrophoneData: (handler: (bytes: Uint8Array) => void) => { remove: () => void }
  readonly onInterruption: (handler: (kind: BridgeAudioInterruption) => void) => {
    remove: () => void
  }
}

/**
 * What the microphone produced and the page has not taken yet, bounded by the page's own budget.
 *
 * The newcomer is dropped rather than the oldest, which is the same decision
 * `MobileDictationPendingAudioBudget.tryReserve` makes on the page: what a page does about a drop
 * is fail the dictation, so recency buys nothing, and dropping from the front would hand the page
 * a splice of two moments that reads as speech nobody said.
 */
class NativeAudioRing {
  private readonly chunks: Uint8Array[] = []
  private pendingBytes = 0
  private droppedBytes = 0

  append(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) {
      return
    }
    if (this.pendingBytes + bytes.byteLength > BRIDGE_AUDIO_RING_MAX_BYTES) {
      this.droppedBytes += bytes.byteLength
      return
    }
    this.chunks.push(bytes)
    this.pendingBytes += bytes.byteLength
  }

  /** Up to `maxBytes` from the front, splitting the chunk the bound falls inside, plus everything
   *  the ring refused since the previous drain. Cleared by the drain that reports it. */
  drain(maxBytes: number): { bytes: Uint8Array; droppedBytes: number } {
    const taking = Math.min(maxBytes, this.pendingBytes)
    const out = new Uint8Array(taking)
    let written = 0
    while (written < taking) {
      const head = this.chunks[0]
      if (head === undefined) {
        break
      }
      const room = taking - written
      if (head.byteLength <= room) {
        out.set(head, written)
        written += head.byteLength
        this.chunks.shift()
        continue
      }
      out.set(head.subarray(0, room), written)
      written += room
      this.chunks[0] = head.subarray(room)
    }
    this.pendingBytes -= written
    const droppedBytes = this.droppedBytes
    this.droppedBytes = 0
    return { bytes: out, droppedBytes }
  }
}

type Capture = {
  readonly ring: NativeAudioRing
  readonly stopListening: () => void
  recording: boolean
  /** The interruption not yet carried to the page. One slot, because what a page does about any of
   *  them is the same and a queue would report a stale one after the live one. */
  interruption: BridgeAudioInterruption | null
}

export type NativeAudioCapture = {
  readonly serve: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
  /** Ends whatever is running. The page session's end and the screen's unmount both call it. */
  readonly dispose: () => void
}

export function createNativeAudioCapture(engine: NativeAudioEngine): NativeAudioCapture {
  let capture: Capture | null = null
  let disposed = false
  /**
   * Starts and stops run one at a time, in the order the page asked for them.
   *
   * Both of them await the device, and both decide what `capture` is when they come back. Two
   * starts overlapping — a page reloaded while the OS prompt is up, which is the very case the
   * replacement rule below exists for — each reached `listen()` and the second overwrote the
   * first's handlers without removing them, leaving the engine calling into a capture nobody could
   * read for the life of the app. A stop overlapping a start found nothing to end and the start
   * opened a microphone after it.
   *
   * Reads stay off this queue: they must not wait behind an opening capture, and a read with no
   * capture is already a refusal rather than a guess.
   */
  let queue: Promise<unknown> = Promise.resolve()

  function enqueue<Value>(action: () => Promise<Value>): Promise<Value> {
    // On both settle paths: a start that failed must not wedge every stop behind it.
    const run = queue.then(action, action)
    queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  function end(): boolean {
    if (capture === null) {
      return false
    }
    capture.stopListening()
    capture = null
    engine.end()
    return true
  }

  function listen(): Capture {
    const ring = new NativeAudioRing()
    const microphone = engine.onMicrophoneData((bytes) => {
      ring.append(bytes)
    })
    const interruptions = engine.onInterruption((kind) => {
      if (capture === null) {
        return
      }
      capture.interruption = kind
      // A capture the page has given up on must not go on filling the ring behind it. The rule is
      // the seam's own, so the shell, the device and the page all end on the same two kinds.
      if (bridgeAudioInterruptionEndsCapture(kind)) {
        capture.recording = false
      }
    })
    return {
      ring,
      stopListening: () => {
        microphone.remove()
        interruptions.remove()
      },
      recording: true,
      interruption: null
    }
  }

  async function start(params: unknown): Promise<unknown> {
    const { sampleRate } = audioStartParamsSchema.parse(params)
    // A page is a document that can navigate, fault or be swiped away mid-capture, and the shell is
    // the only side that notices. So a second start replaces the first rather than refusing it,
    // which would leave the microphone held by a document that is gone.
    end()
    const permission = await engine.requestPermission()
    if (permission !== 'granted') {
      return { started: false, sampleRate, permission }
    }
    const opened = await engine.open(sampleRate)
    if (!opened.opened) {
      return { started: false, sampleRate: opened.sampleRate, permission }
    }
    // The session can end while the device is still opening. Nothing subscribes after that: the
    // dispose has already run, and a capture opened behind it would have no owner to stop it.
    // The open succeeded though — on a phone that is `initialize()` bringing the audio session up —
    // so it is torn down here. `end()` below is a no-op with no capture, and nobody else will call
    // one, so simply returning would leave the device's session up for the life of the app.
    if (disposed) {
      engine.end()
      return { started: false, sampleRate: opened.sampleRate, permission }
    }
    capture = listen()
    if (!engine.begin()) {
      end()
      return { started: false, sampleRate: opened.sampleRate, permission }
    }
    return { started: true, sampleRate: opened.sampleRate, permission }
  }

  function read(params: unknown): unknown {
    const { maxBytes } = audioReadParamsSchema.parse(params)
    const live = capture
    if (live === null) {
      throw new BridgeNativeVerbRefusedError(
        'native_audio_not_capturing',
        'this session has no capture to read from'
      )
    }
    const drained = live.ring.drain(maxBytes)
    const interruption = live.interruption
    live.interruption = null
    return {
      base64: bytesToBase64(drained.bytes),
      droppedBytes: drained.droppedBytes,
      recording: live.recording,
      interruption
    }
  }

  return {
    serve: async (verb, params) => {
      if (verb === 'native.audio.start') {
        return enqueue(() => start(params))
      }
      if (verb === 'native.audio.read') {
        return read(params)
      }
      audioStopParamsSchema.parse(params)
      // Queued so a stop that followed a start ends the capture that start opened, rather than
      // finding nothing and leaving a live microphone behind it.
      return enqueue(async () => ({ stopped: end() }))
    },
    dispose: () => {
      disposed = true
      end()
    }
  }
}
