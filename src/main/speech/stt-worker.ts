/* oxlint-disable typescript-eslint/no-explicit-any -- sherpa-onnx native addon has no type definitions */
import type { MessagePortMain } from 'electron'
import type { SpeechAudioPortMessage } from '../../shared/speech-types'
import { resampleToRate } from './stt-audio-resample'
import { OfflineAudioChunker } from './stt-offline-audio-chunker'
import { buildRecognizerConfig } from './stt-worker-model-config'
import { createStopTailPadding } from './stt-stop-tail-padding'
import { connectSttWorkerParentPort } from './stt-worker-parent-port'
import type { SttWorkerRequest as WorkerMessage } from './stt-worker-process'

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

// A desktop renderer's audio for one stream, posted straight here instead of through main.
type AudioPortInput = {
  port: MessagePortMain
  onEnded: (() => void) | null
}

const parentPort = connectSttWorkerParentPort()
// Use the platform native addon: the main sherpa-onnx WASM package cannot load host model files. Main supplies its resolved path.
let sherpa: any = null
let recognizer: any = null
let isStreaming = false
let modelSampleRate = 16000
const streams = new Map<string, SessionStream>()
const audioPorts = new Map<string, AudioPortInput>()

function loadSherpa(modulePath: string | undefined): any {
  if (!modulePath) {
    throw new Error('init.sherpaModulePath is required')
  }
  return require(modulePath)
}

function handleInit(msg: Extract<WorkerMessage, { type: 'init' }>): void {
  try {
    sherpa = loadSherpa(msg.sherpaModulePath)
    isStreaming = msg.streaming
    modelSampleRate = msg.sampleRate
    const { online, config } = buildRecognizerConfig(msg)
    recognizer = online
      ? sherpa.createOnlineRecognizer(config)
      : sherpa.createOfflineRecognizer(config)
    parentPort.post({ type: 'ready' })
  } catch (err) {
    parentPort.post({ type: 'error', error: String(err) })
  }
}

function openStream(streamId: string): SessionStream {
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

function decodeOfflineChunk(samples: Float32Array): string {
  const stream = sherpa.createOfflineStream(recognizer)
  sherpa.acceptWaveformOffline(stream, { sampleRate: modelSampleRate, samples })
  sherpa.decodeOfflineStream(recognizer, stream)
  const result = JSON.parse(sherpa.getOfflineStreamResultAsJson(stream))
  return result?.text?.trim() ?? ''
}

function feedOnline(streamId: string, stream: SessionStream, samples: Float32Array): void {
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
    parentPort.post({ type: 'partial', streamId, text })
  }
  if (sherpa.isEndpoint(recognizer, stream.online)) {
    if (text) {
      parentPort.post({ type: 'final', streamId, text })
    }
    sherpa.reset(recognizer, stream.online)
    stream.lastPartialText = ''
  }
}

function feedOffline(streamId: string, stream: SessionStream, samples: Float32Array): void {
  // Bound ONNX allocations below Chromium's >=2GiB crash threshold (#7925); consumers append final segments.
  const readyChunks = stream.offlineChunker?.push(new Float32Array(samples)) ?? []
  // push() already consumed these windows; keep decoding later ones after a failure.
  let firstError: unknown = null
  for (const chunk of readyChunks) {
    try {
      const text = decodeOfflineChunk(chunk)
      if (text) {
        parentPort.post({ type: 'final', streamId, text })
      }
    } catch (err) {
      firstError ??= err
    }
  }
  if (firstError) {
    throw firstError
  }
}

function handleFeed(msg: Extract<WorkerMessage, { type: 'feed' }>): void {
  if (!recognizer) {
    return
  }
  try {
    const stream = openStream(msg.streamId)
    // Normalize rates before native decode: mixed rates on one recognizer abort the process.
    const samples = resampleToRate(msg.samples, msg.sampleRate || modelSampleRate, modelSampleRate)
    if (isStreaming) {
      feedOnline(msg.streamId, stream, samples)
    } else {
      feedOffline(msg.streamId, stream, samples)
    }
  } catch (err) {
    parentPort.post({ type: 'error', streamId: msg.streamId, error: String(err) })
  }
}

function finishStream(stream: SessionStream): string {
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

function attachAudioPort(streamId: string, port: MessagePortMain | undefined): void {
  if (!port) {
    return
  }
  const input: AudioPortInput = { port, onEnded: null }
  // The renderer closes its end after 'end'; a close alone means it went away.
  const end = (): void => {
    if (audioPorts.get(streamId) !== input) {
      return
    }
    audioPorts.delete(streamId)
    port.close()
    input.onEnded?.()
  }
  port.on('message', ({ data }) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the desktop preload holds the other end, and it sends SpeechAudioPortMessage.
    const msg = data as SpeechAudioPortMessage
    if (msg.type === 'end') {
      end()
    } else {
      handleFeed({ type: 'feed', streamId, samples: msg.samples, sampleRate: msg.sampleRate })
    }
  })
  port.on('close', end)
  audioPorts.set(streamId, input)
  port.start()
}

function handleStop(streamId: string): void {
  const input = audioPorts.get(streamId)
  // Main's stop can overtake the renderer's last frames on the port; finish only after them.
  if (input) {
    input.onEnded = () => handleStop(streamId)
    return
  }
  const stream = streams.get(streamId)
  streams.delete(streamId)
  try {
    const text = stream && recognizer ? finishStream(stream) : ''
    if (text) {
      parentPort.post({ type: 'final', streamId, text })
    }
  } catch (err) {
    parentPort.post({ type: 'error', streamId, error: String(err) })
  } finally {
    parentPort.post({ type: 'stopped', streamId })
  }
}

// A canceled dictation drops its audio undecoded.
function handleDiscard(streamId: string): void {
  const input = audioPorts.get(streamId)
  audioPorts.delete(streamId)
  input?.port.close()
  streams.delete(streamId)
  parentPort.post({ type: 'stopped', streamId })
}

parentPort.onMessage((message, ports) => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the session host posts here, and it sends WorkerMessage.
  const msg = message as WorkerMessage
  switch (msg.type) {
    case 'init':
      handleInit(msg)
      break
    case 'feed':
      handleFeed(msg)
      break
    case 'stop':
      handleStop(msg.streamId)
      break
    case 'discard':
      handleDiscard(msg.streamId)
      break
    case 'attach-audio':
      attachAudioPort(msg.streamId, ports[0])
      break
  }
})
