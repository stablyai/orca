import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  DEFAULT_DICTATION_METER,
  analyzeDictationAudioChunk,
  createDictationMeterAnalyzerState,
  dictationMeterStatesEqual,
  toPublicDictationMeterState,
  type DictationMeterAnalyzerState,
  type DictationMeterState
} from '../../../src/shared/dictation-audio-meter'
import {
  DICTATION_SAMPLE_RATE,
  PCM_BYTES_PER_SAMPLE
} from '../../../src/shared/rpc-contract/speech-params'
import type { DictationCapture } from '../platform/dictation-capture-contract'

const WINDOW_MS = 50
const WINDOW_SAMPLES = (DICTATION_SAMPLE_RATE * WINDOW_MS) / 1000
// The page shell drains every 500 ms; more backlog than two drains only adds lag.
const MAX_BACKLOG_MS = 1_000

export type MobileDictationMeterState = DictationMeterState & {
  /** Date.now() when recording began; 0 while idle. */
  readonly startedAt: number
}

export type MobileDictationMeter = {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => MobileDictationMeterState
  readonly start: () => void
  readonly push: (pcm: Uint8Array) => void
  readonly stop: () => void
}

const IDLE_METER: MobileDictationMeterState = { ...DEFAULT_DICTATION_METER, startedAt: 0 }

type QueuedWindow = { readonly meter: DictationMeterState; readonly durationMs: number }

// Measure the 16-bit PCM the phone already streams, so both shells get a level without a native event crossing the page bridge.
export function createMobileDictationMeter(): MobileDictationMeter {
  const listeners = new Set<() => void>()
  let snapshot = IDLE_METER
  let analyzer: DictationMeterAnalyzerState = createDictationMeterAnalyzerState()
  let sampleClockMs = 0
  let queue: QueuedWindow[] = []
  let queuedMs = 0
  let creditMs = 0
  let lastTickAt = 0
  let timer: ReturnType<typeof setInterval> | null = null

  function publish(next: MobileDictationMeterState): void {
    if (next.startedAt === snapshot.startedAt && dictationMeterStatesEqual(next, snapshot)) {
      return
    }
    snapshot = next
    for (const listener of listeners) {
      listener()
    }
  }

  // Play windows back at the pace they were captured, so a 500 ms page batch moves the dots smoothly instead of in one jump.
  function tick(): void {
    const now = performance.now()
    creditMs += now - lastTickAt
    lastTickAt = now
    let played = 0
    while (played < queue.length && queue[played].durationMs <= creditMs) {
      creditMs -= queue[played].durationMs
      queuedMs -= queue[played].durationMs
      played += 1
    }
    const next = played > 0 ? queue[played - 1].meter : null
    queue.splice(0, played)
    if (queue.length === 0) {
      creditMs = 0
    }
    if (next) {
      publish({ ...next, startedAt: snapshot.startedAt })
    }
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    queue = []
    queuedMs = 0
    publish(IDLE_METER)
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshot,
    start: () => {
      stop()
      analyzer = createDictationMeterAnalyzerState()
      sampleClockMs = 0
      creditMs = 0
      lastTickAt = performance.now()
      timer = setInterval(tick, WINDOW_MS)
      publish({ ...DEFAULT_DICTATION_METER, startedAt: Date.now() })
    },
    push: (pcm) => {
      if (timer === null) {
        return
      }
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
      const sampleCount = Math.floor(pcm.byteLength / PCM_BYTES_PER_SAMPLE)
      for (let first = 0; first < sampleCount; first += WINDOW_SAMPLES) {
        const samples = new Float32Array(Math.min(WINDOW_SAMPLES, sampleCount - first))
        for (let index = 0; index < samples.length; index += 1) {
          samples[index] = view.getInt16((first + index) * PCM_BYTES_PER_SAMPLE, true) / 32768
        }
        const durationMs = (samples.length * 1000) / DICTATION_SAMPLE_RATE
        sampleClockMs += durationMs
        analyzer = analyzeDictationAudioChunk(samples, sampleClockMs, analyzer)
        queue.push({ meter: toPublicDictationMeterState(analyzer), durationMs })
        queuedMs += durationMs
      }
      let dropped = 0
      while (queuedMs > MAX_BACKLOG_MS && dropped < queue.length - 1) {
        queuedMs -= queue[dropped].durationMs
        dropped += 1
      }
      queue.splice(0, dropped)
    },
    stop
  }
}

export function useMobileDictationMeter(
  capture: DictationCapture,
  recording: boolean
): MobileDictationMeter {
  const [meter] = useState(createMobileDictationMeter)
  useEffect(() => {
    if (!recording) {
      return
    }
    meter.start()
    const subscription = capture.onChunk((chunk) => meter.push(chunk.data))
    return () => {
      subscription.remove()
      meter.stop()
    }
  }, [capture, meter, recording])
  return meter
}

export function useMobileDictationMeterState(
  meter: MobileDictationMeter
): MobileDictationMeterState {
  return useSyncExternalStore(meter.subscribe, meter.getSnapshot)
}
