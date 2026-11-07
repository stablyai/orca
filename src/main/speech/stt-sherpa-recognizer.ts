/* oxlint-disable typescript-eslint/no-explicit-any -- sherpa-onnx native addon has no type definitions */
import { join } from 'node:path'
import { speechRecognizerPackageName } from '../../shared/speech-recognizer-package'
import { resampleToRate } from './stt-audio-resample'
import { OfflineAudioChunker } from './stt-offline-audio-chunker'
import { buildRecognizerConfig } from './stt-worker-model-config'
import { createStopTailPadding } from './stt-stop-tail-padding'
import type { SttRecognizer, SttRecognizerInit, SttRecognizerPost } from './stt-recognizer'

// One per dictation session; every session shares the one loaded recognizer.
type SessionStream = {
  // Online streams live for the session; offline ones are made per decode.
  online: any
  offlineChunker: OfflineAudioChunker | null
  // Primed on the session's first feed so stop never waits on another session's stream.
  primed: boolean
  // Streaming models report the same hypothesis on most 100 ms feeds; only changes are posted.
  lastPartialText: string
}

export function createSherpaRecognizer(
  init: SttRecognizerInit,
  post: SttRecognizerPost
): SttRecognizer {
  // Use the platform native addon: the main sherpa-onnx WASM package cannot load host model files.
  const sherpa: any = require(
    join(init.speechModulesDir, speechRecognizerPackageName(process.platform, process.arch))
  )
  const { streaming: isStreaming, sampleRate: modelSampleRate } = init
  const { online, config } = buildRecognizerConfig(init)
  const recognizer = online
    ? sherpa.createOnlineRecognizer(config)
    : sherpa.createOfflineRecognizer(config)
  const streams = new Map<string, SessionStream>()

  const openStream = (streamId: string): SessionStream => {
    const existing = streams.get(streamId)
    if (existing) {
      return existing
    }
    const stream: SessionStream = {
      online: isStreaming ? sherpa.createOnlineStream(recognizer) : null,
      offlineChunker: isStreaming ? null : new OfflineAudioChunker(modelSampleRate),
      primed: false,
      lastPartialText: ''
    }
    streams.set(streamId, stream)
    return stream
  }

  const decodeOfflineChunk = (samples: Float32Array): string => {
    const stream = sherpa.createOfflineStream(recognizer)
    sherpa.acceptWaveformOffline(stream, { sampleRate: modelSampleRate, samples })
    sherpa.decodeOfflineStream(recognizer, stream)
    const result = JSON.parse(sherpa.getOfflineStreamResultAsJson(stream))
    return result?.text?.trim() ?? ''
  }

  const feedOnline = (streamId: string, stream: SessionStream, samples: Float32Array): void => {
    if (!stream.primed) {
      // New streams start with empty encoder caches; zipformer en-20M dropped most of the first second
      // (first word wrong on 71 of 73 LibriSpeech clips). A second of silence fills them first.
      sherpa.acceptWaveformOnline(stream.online, {
        sampleRate: modelSampleRate,
        samples: new Float32Array(modelSampleRate)
      })
      stream.primed = true
    }
    sherpa.acceptWaveformOnline(stream.online, { sampleRate: modelSampleRate, samples })
    while (sherpa.isOnlineStreamReady(recognizer, stream.online)) {
      sherpa.decodeOnlineStream(recognizer, stream.online)
    }
    const result = JSON.parse(sherpa.getOnlineStreamResultAsJson(recognizer, stream.online))
    const text = result?.text?.trim()
    if (text && text !== stream.lastPartialText) {
      stream.lastPartialText = text
      post({ type: 'partial', streamId, text })
    }
    if (sherpa.isEndpoint(recognizer, stream.online)) {
      if (text) {
        post({ type: 'final', streamId, text })
      }
      sherpa.reset(recognizer, stream.online)
      stream.lastPartialText = ''
    }
  }

  const feedOffline = (streamId: string, stream: SessionStream, samples: Float32Array): void => {
    // Bound ONNX allocations below Chromium's >=2GiB crash threshold (#7925); consumers append final segments.
    const readyChunks = stream.offlineChunker?.push(new Float32Array(samples)) ?? []
    // push() already consumed these windows; keep decoding later ones after a failure.
    let firstError: unknown = null
    for (const chunk of readyChunks) {
      try {
        const text = decodeOfflineChunk(chunk)
        if (text) {
          post({ type: 'final', streamId, text })
        }
      } catch (err) {
        firstError ??= err
      }
    }
    if (firstError) {
      throw firstError
    }
  }

  const finishStream = (stream: SessionStream): string => {
    if (stream.online) {
      sherpa.acceptWaveformOnline(stream.online, {
        sampleRate: modelSampleRate,
        samples: createStopTailPadding(modelSampleRate)
      })
      sherpa.inputFinished(stream.online)
      while (sherpa.isOnlineStreamReady(recognizer, stream.online)) {
        sherpa.decodeOnlineStream(recognizer, stream.online)
      }
      const result = JSON.parse(sherpa.getOnlineStreamResultAsJson(recognizer, stream.online))
      return result?.text?.trim() ?? ''
    }
    // flush() leaves less than one bounded chunk.
    const remaining = stream.offlineChunker?.flush()
    return remaining && remaining.length > 0 ? decodeOfflineChunk(remaining) : ''
  }

  return {
    feed(streamId, samples, sampleRate) {
      const stream = openStream(streamId)
      // Normalize rates before native decode: mixed rates on one recognizer abort the process.
      const resampled = resampleToRate(samples, sampleRate || modelSampleRate, modelSampleRate)
      if (isStreaming) {
        feedOnline(streamId, stream, resampled)
      } else {
        feedOffline(streamId, stream, resampled)
      }
    },
    finish(streamId) {
      const stream = streams.get(streamId)
      streams.delete(streamId)
      const text = stream ? finishStream(stream) : ''
      if (text) {
        post({ type: 'final', streamId, text })
      }
    },
    discard(streamId) {
      streams.delete(streamId)
    }
  }
}
