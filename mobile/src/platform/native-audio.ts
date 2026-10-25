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
import type { MicrophoneScreenLock } from './microphone-screen-lock'

// Keep transcription protocol in the page so it can update without a binary release; the shell owns only microphone permission and PCM capture.

export type NativeAudioEngine = {
  readonly requestPermission: () => Promise<BridgeAudioPermission>
  readonly open: (sampleRate: number) => Promise<{ opened: boolean; sampleRate: number }>
  readonly begin: () => boolean
  readonly end: () => void
  // Hold the screen with an open mic because locking suspends capture; inject the device wake API for tests.
  readonly screenLock: MicrophoneScreenLock
  readonly onMicrophoneData: (handler: (bytes: Uint8Array) => void) => { remove: () => void }
  readonly onInterruption: (handler: (kind: BridgeAudioInterruption) => void) => {
    remove: () => void
  }
}

// Drop new audio on overflow, matching the page budget: dropping old bytes would splice unrelated speech before dictation fails.
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
  // Keep only the latest pending interruption so reads cannot replay stale OS state.
  interruption: BridgeAudioInterruption | null
}

export type NativeAudioCapture = {
  readonly serve: (verb: BridgeNativeVerb, params: unknown) => Promise<unknown>
  readonly dispose: () => void
}

export function createNativeAudioCapture(engine: NativeAudioEngine): NativeAudioCapture {
  const screen = engine.screenLock
  let capture: Capture | null = null
  let disposed = false
  // Serialize starts/stops so overlapping opens cannot orphan listeners and a stop cannot run before its start finishes. Reads remain immediate and refuse without capture.
  let queue: Promise<unknown> = Promise.resolve()

  function enqueue<Value>(action: () => Promise<Value>): Promise<Value> {
    // A failed start must not block later stops.
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
    screen.release()
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
      // Match native/page interruption rules so abandoned dictation cannot continue recording.
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
    // Replace prior capture because its page may have navigated or disappeared without stopping it.
    end()
    const permission = await engine.requestPermission()
    if (permission !== 'granted') {
      return { started: false, sampleRate, permission }
    }
    const opened = await engine.open(sampleRate)
    if (!opened.opened) {
      return { started: false, sampleRate: opened.sampleRate, permission }
    }
    // Dispose may finish during open; close the successful device session directly because no capture exists for end() to close.
    if (disposed) {
      engine.end()
      return { started: false, sampleRate: opened.sampleRate, permission }
    }
    capture = listen()
    // Hold only after opening; every subsequent failure must release through end().
    screen.hold()
    try {
      if (!engine.begin()) {
        end()
        return { started: false, sampleRate: opened.sampleRate, permission }
      }
    } catch (error) {
      end()
      throw error
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
      // Queue stop behind start so it cannot miss an opening capture.
      return enqueue(async () => {
        // Drain before end destroys the ring, preserving audio since the last page read.
        const drained = capture?.ring.drain(BRIDGE_AUDIO_RING_MAX_BYTES)
        return {
          stopped: end(),
          base64: drained === undefined ? '' : bytesToBase64(drained.bytes),
          droppedBytes: drained?.droppedBytes ?? 0
        }
      })
    },
    dispose: () => {
      disposed = true
      end()
    }
  }
}
