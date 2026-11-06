/* oxlint-disable typescript-eslint/no-explicit-any -- sherpa-onnx native addon has no type definitions */
import { parentPort, workerData } from 'node:worker_threads'
import { resampleToRate } from './stt-audio-resample'
import { OfflineAudioChunker } from './stt-offline-audio-chunker'
import { buildRecognizerConfig, type RecognizerConfigInput } from './stt-worker-model-config'
import { createStopTailPadding } from './stt-stop-tail-padding'

type WorkerMessage =
  | ({ type: 'init' } & RecognizerConfigInput)
  | { type: 'feed'; samples: Float32Array; sampleRate: number }
  | { type: 'stop' }
  | { type: 'discard' }
  | { type: 'teardown' }

// Use the platform native addon: the main sherpa-onnx WASM package cannot load host model files. Main supplies its resolved path.
let sherpa: any = null
let recognizer: any = null
let stream: any = null
let isStreaming = false
let offlineChunker: OfflineAudioChunker | null = null
let offlineSampleRate = 16000
// Primed on a session's first feed so stop never waits on the next session's stream.
let streamPrimed = false
// Streaming models report the same hypothesis on most 100 ms feeds; only changes are posted.
let lastPartialText = ''

function loadSherpa(): any {
  const modulePath = workerData?.sherpaModulePath
  if (!modulePath) {
    throw new Error('workerData.sherpaModulePath is required')
  }
  return require(modulePath)
}

function handleInit(msg: Extract<WorkerMessage, { type: 'init' }>): void {
  try {
    sherpa = loadSherpa()

    const { streaming, sampleRate } = msg
    isStreaming = streaming
    offlineChunker = streaming ? null : new OfflineAudioChunker(sampleRate)
    offlineSampleRate = sampleRate

    const { online, config } = buildRecognizerConfig(msg)
    recognizer = online
      ? sherpa.createOnlineRecognizer(config)
      : sherpa.createOfflineRecognizer(config)
    stream = online ? sherpa.createOnlineStream(recognizer) : sherpa.createOfflineStream(recognizer)

    parentPort?.postMessage({ type: 'ready' })
  } catch (err) {
    parentPort?.postMessage({ type: 'error', error: String(err) })
  }
}

// Offline streams are single-use; refresh even after failed decodes on a warm worker.
function decodeOfflineChunk(samples: Float32Array): string {
  try {
    sherpa.acceptWaveformOffline(stream, { sampleRate: offlineSampleRate, samples })
    sherpa.decodeOfflineStream(recognizer, stream)
    const resultJson = sherpa.getOfflineStreamResultAsJson(stream)
    const result = JSON.parse(resultJson)
    return result?.text?.trim() ?? ''
  } finally {
    if (sherpa && recognizer) {
      stream = sherpa.createOfflineStream(recognizer)
    }
  }
}

// Discard residual audio and spent streams so a warm worker never carries one session into the next.
function resetSessionState(): void {
  streamPrimed = false
  lastPartialText = ''
  try {
    if (!isStreaming) {
      offlineChunker = new OfflineAudioChunker(offlineSampleRate)
    }
    if (sherpa && recognizer) {
      stream = isStreaming
        ? sherpa.createOnlineStream(recognizer)
        : sherpa.createOfflineStream(recognizer)
    }
  } catch {
    // The old stream still holds the last session's audio; exiting settles stop and forces a fresh worker.
    process.exit(1)
  }
}

function handleFeed(msg: Extract<WorkerMessage, { type: 'feed' }>): void {
  if (!recognizer || !stream) {
    return
  }

  try {
    const inputRate = msg.sampleRate || offlineSampleRate
    // Normalize rates before native decode: mixed rates on one recognizer abort the process.
    const samples = resampleToRate(msg.samples, inputRate, offlineSampleRate)
    if (isStreaming) {
      if (!streamPrimed) {
        // New streams start with empty encoder caches; zipformer en-20M dropped most of the first second
        // (first word wrong on 71 of 73 LibriSpeech clips). A second of silence fills them first.
        sherpa.acceptWaveformOnline(stream, {
          sampleRate: offlineSampleRate,
          samples: new Float32Array(offlineSampleRate)
        })
        streamPrimed = true
      }
      sherpa.acceptWaveformOnline(stream, { sampleRate: offlineSampleRate, samples })

      while (sherpa.isOnlineStreamReady(recognizer, stream)) {
        sherpa.decodeOnlineStream(recognizer, stream)
      }

      const resultJson = sherpa.getOnlineStreamResultAsJson(recognizer, stream)
      const result = JSON.parse(resultJson)
      const text = result?.text?.trim()
      if (text && text !== lastPartialText) {
        lastPartialText = text
        parentPort?.postMessage({ type: 'partial', text })
      }

      if (sherpa.isEndpoint(recognizer, stream)) {
        const finalText = result?.text?.trim()
        if (finalText) {
          parentPort?.postMessage({ type: 'final', text: finalText })
        }
        sherpa.reset(recognizer, stream)
        lastPartialText = ''
      }
    } else {
      // Bound ONNX allocations below Chromium's >=2GiB crash threshold (#7925); consumers append final segments.
      const readyChunks = offlineChunker?.push(new Float32Array(samples)) ?? []
      // push() already consumed these windows; decode later ones after failures using the refreshed stream.
      let firstError: unknown = null
      for (const chunk of readyChunks) {
        try {
          const text = decodeOfflineChunk(chunk)
          if (text) {
            parentPort?.postMessage({ type: 'final', text })
          }
        } catch (err) {
          firstError ??= err
        }
      }
      if (firstError) {
        throw firstError
      }
    }
  } catch (err) {
    parentPort?.postMessage({ type: 'error', error: String(err) })
  }
}

function handleStop(): void {
  if (!recognizer || !stream) {
    parentPort?.postMessage({ type: 'stopped' })
    return
  }

  try {
    if (isStreaming) {
      sherpa.acceptWaveformOnline(stream, {
        sampleRate: offlineSampleRate,
        samples: createStopTailPadding(offlineSampleRate)
      })
      sherpa.inputFinished(stream)
      while (sherpa.isOnlineStreamReady(recognizer, stream)) {
        sherpa.decodeOnlineStream(recognizer, stream)
      }
      const resultJson = sherpa.getOnlineStreamResultAsJson(recognizer, stream)
      const result = JSON.parse(resultJson)
      const text = result?.text?.trim()
      if (text) {
        parentPort?.postMessage({ type: 'final', text })
      }
    } else {
      // flush() leaves less than one bounded chunk.
      const remaining = offlineChunker?.flush()
      if (remaining && remaining.length > 0) {
        const text = decodeOfflineChunk(remaining)
        if (text) {
          parentPort?.postMessage({ type: 'final', text })
        }
      }
    }
  } catch (err) {
    parentPort?.postMessage({ type: 'error', error: String(err) })
  } finally {
    resetSessionState()
    // Recovery must not suppress the stopped signal awaited by stopDictation.
    parentPort?.postMessage({ type: 'stopped' })
  }
}

// A canceled dictation drops its audio undecoded so the warm worker is free at once.
function handleDiscard(): void {
  resetSessionState()
  parentPort?.postMessage({ type: 'stopped' })
}

function handleTeardown(): void {
  stream = null
  recognizer = null
  sherpa = null
  offlineChunker = null
  process.exit(0)
}

parentPort?.on('message', (msg: WorkerMessage) => {
  switch (msg.type) {
    case 'init':
      handleInit(msg)
      break
    case 'feed':
      handleFeed(msg)
      break
    case 'stop':
      handleStop()
      break
    case 'discard':
      handleDiscard()
      break
    case 'teardown':
      handleTeardown()
      break
  }
})
