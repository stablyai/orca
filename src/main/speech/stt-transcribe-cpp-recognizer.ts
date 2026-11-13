import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as TranscribeCpp from 'transcribe-cpp'
import { appendDictationText } from '../../shared/dictation-transcript-spacing'
import { resampleToRate } from './stt-audio-resample'
import {
  type AudioSegmenter,
  boundedChunks,
  joinAudio,
  OFFLINE_DECODE_CHUNK_SECONDS
} from './stt-offline-audio-chunker'
import { LiveDecode, warmUpLiveDecode } from './stt-live-decode'
import { loadSileroVad, VadPauseSegmenter } from './stt-vad-pause-segmenter'
import type { SttRecognizer, SttRecognizerInit, SttRecognizerPost } from './stt-recognizer'

// Past ~8 threads decode slowed 2-4x under load in the 2026-11 benchmark; E-cores and SMT siblings
// don't help. Half the logical CPUs is close to the performance cores on Apple silicon and SMT x86.
function performanceCoreThreads(): number {
  const logical = availableParallelism()
  return Math.min(logical, 8, Math.max(4, Math.floor(logical / 2)))
}

// Totals, not the nominal rate ratio: per-feed resampling rounds, and the drift would replay decoded audio.
type StreamCoverage = {
  options: TranscribeCpp.TranscribeOptions
  /** Streaming models only, unless another dictation already streams. */
  live: LiveDecode | null
  segmenter: AudioSegmenter
  vad: TranscribeCpp.VadSession | null
  inputSamples: number
  resampledSamples: number
  reportedSamples: number
  /** Stream position the last phrase decode reached, for its speed check. */
  decodedSamples: number
  slowPhraseDecodes: number
  speechPending: boolean
  /** Phrases since the last commit and their live text. */
  span: { audio: Float32Array[]; samples: number; texts: string[] }
}

// Whisper pads every decode to a 30 s window, so each phrase costs a full decode. Where that takes longer than the
// speech (and silence) it covers, per-pause decodes queue up behind the speaker, so that dictation stops cutting.
// Two in a row, so one slow first run or load spike doesn't.
const SLOW_PHRASE_DECODES_BEFORE_NO_CUTS = 2

// Dropped silence still counts as covered; report it so the host's replay buffer and stall watch don't grow through long pauses.
const SILENCE_COVERAGE_REPORT_SECONDS = 5

// The CPU fallback keeps uncommitted audio for a replay and takes over 30 s of it for a stalled GPU.
const COMMIT_AFTER_SECONDS = 20
// A live dictation with no quiet to commit at restarts its stream by then, at a pause if it can.
const LIVE_COMMIT_BY_SECONDS = 25

export async function createTranscribeCppRecognizer(
  init: SttRecognizerInit,
  post: SttRecognizerPost
): Promise<SttRecognizer> {
  const entry = join(init.speechModulesDir, 'transcribe-cpp', 'dist', 'index.js')
  const transcribe: typeof TranscribeCpp = await import(pathToFileURL(entry).href)
  const gguf = init.files.find((file) => file.endsWith('.gguf'))
  if (!gguf) {
    throw new Error(`No .gguf model file in: ${init.files.join(', ')}`)
  }
  // Device setup (Metal shader library, Vulkan drivers) and reading the weights each report done,
  // so a cold disk or a busy machine isn't taken for a GPU that hung.
  await transcribe.initialize()
  post({ type: 'loading' })
  const model = await transcribe.TranscribeModel.load(join(init.modelDir, gguf))
  post({ type: 'loading' })
  // The child runs one call at a time, so every stream can share one session.
  const session = model.createSession({ nThreads: performanceCoreThreads() })
  const { languages } = model.capabilities
  // The setting is ISO-639-1; Nemotron names locales (ko-KR) and rejects the bare code.
  const language = init.language
    ? (languages.find((code) => code === init.language) ??
      languages.find((code) => code.startsWith(`${init.language}-`)))
    : undefined
  const baseOptions: TranscribeCpp.TranscribeOptions = {
    timestamps: 'none',
    ...(language ? { language } : {})
  }
  // A plain list as context, not the `vocabulary` option: in the 2026-11 dev bench that dropped
  // Whisper's sentence-final periods. Whisper keeps a long prompt's end, so the first terms go last.
  const streamOptions = (vocabulary: readonly string[]): TranscribeCpp.TranscribeOptions =>
    vocabulary.length > 0 && model.supports('context_prompt')
      ? { ...baseOptions, prompt: `${vocabulary.toReversed().join(', ')}.` }
      : baseOptions
  const modelRate = model.capabilities.nativeSampleRate || init.sampleRate
  const vadModel = await loadSileroVad(transcribe, init.vadModelPath, modelRate)
  const streams = new Map<string, StreamCoverage>()
  const openStream = (streamId: string, vocabulary: readonly string[]): StreamCoverage => {
    // A dictation that starts beside a live one is pause-cut, so the two don't take the model from each other per feed.
    const live =
      model.capabilities.supportsStreaming &&
      ![...streams].some(([id, other]) => id !== streamId && other.live)
    // A VAD stream is per-dictation state, so each dictation gets its own session.
    const vad = vadModel?.createVadSession({ nThreads: 1 }) ?? null
    const stream: StreamCoverage = {
      options: streamOptions(vocabulary),
      live: live
        ? new LiveDecode(
            session,
            streamOptions(vocabulary),
            modelRate,
            vad && vadModel && { vad, frameSamples: vadModel.vadInfo.frameSamples }
          )
        : null,
      segmenter: boundedChunks(modelRate),
      vad,
      inputSamples: 0,
      resampledSamples: 0,
      reportedSamples: 0,
      decodedSamples: 0,
      slowPhraseDecodes: 0,
      speechPending: false,
      span: { audio: [], samples: 0, texts: [] }
    }
    if (vad && vadModel && !live) {
      stream.segmenter = new VadPauseSegmenter(
        vad,
        modelRate,
        vadModel.vadInfo.frameSamples,
        () => stream.slowPhraseDecodes < SLOW_PHRASE_DECODES_BEFORE_NO_CUTS
      )
    }
    const replaced = streams.get(streamId)
    if (replaced) {
      dropStream(replaced)
    }
    streams.set(streamId, stream)
    return stream
  }

  const dropStream = (stream: StreamCoverage) => {
    stream.vad?.dispose()
    stream.live?.reset()
  }

  const transcribeChunk = async (
    chunk: Float32Array,
    options: TranscribeCpp.TranscribeOptions
  ): Promise<string> => {
    // transcribe-cpp lets one native stream hold the model at a time.
    const holder = [...streams].find(([, other]) => other.live?.holdsModel)
    if (holder) {
      await endLive(...holder)
    }
    try {
      return (await session.run(chunk, options)).text
    } catch (error) {
      // Repetition loops (Whisper on noise) and length caps are about this audio, not the GPU; keep what decoded.
      if (error instanceof transcribe.OutputTruncated) {
        return error.partialResult?.text ?? ''
      }
      throw error
    }
  }

  // Stream position (model-rate samples) the segmenter has handed on, less chunks still waiting to be decoded.
  const position = (stream: StreamCoverage, undecoded: number) =>
    stream.resampledSamples - stream.segmenter.heldSamples - undecoded

  // `covered`: stream position (model-rate samples) the posted text accounts for. Reported in input-rate samples
  // so the host can trim the audio it keeps for a CPU replay.
  const report = (streamId: string, stream: StreamCoverage, text: string, covered: number) => {
    stream.reportedSamples = covered
    post({
      type: 'chunk',
      streamId,
      text,
      samples: Math.round((covered * stream.inputSamples) / stream.resampledSamples)
    })
  }

  // Canceled streams, until their queued discard runs; also covers a finish that already closed its stream.
  const canceled = new Set<string>()

  const spanLimit = OFFLINE_DECODE_CHUNK_SECONDS * modelRate

  // The span's phrases decode again together, so a pause mid-sentence doesn't capitalize the words after it.
  const commit = async (streamId: string, stream: StreamCoverage, undecoded: number) => {
    const { audio, texts } = stream.span
    if (audio.length === 0 || canceled.has(streamId)) {
      return
    }
    stream.span = { audio: [], samples: 0, texts: [] }
    const text =
      audio.length === 1 && texts.length === 1
        ? texts[0]
        : (await transcribeChunk(joinAudio(audio), stream.options)).trim()
    report(streamId, stream, text, position(stream, undecoded))
  }

  /** `live`: decode each phrase as it ends for live text; at stop only the commit decodes. */
  const decode = async (
    streamId: string,
    stream: StreamCoverage,
    chunks: Float32Array[],
    live: boolean
  ) => {
    let undecoded = chunks.reduce((total, chunk) => total + chunk.length, 0)
    for (const chunk of chunks) {
      if (canceled.has(streamId)) {
        return
      }
      if (stream.span.samples + chunk.length > spanLimit) {
        await commit(streamId, stream, undecoded)
      }
      undecoded -= chunk.length
      stream.span.audio.push(chunk)
      stream.span.samples += chunk.length
      if (!live) {
        continue
      }
      const startedAt = performance.now()
      const text = (await transcribeChunk(chunk, stream.options)).trim()
      const decodeMs = performance.now() - startedAt
      stream.span.texts.push(text)
      post({ type: 'partial', streamId, text: stream.span.texts.reduce(appendDictationText, '') })
      const reached = position(stream, undecoded)
      if (stream.vad) {
        noteDecodeSpeed(stream, decodeMs, ((reached - stream.decodedSamples) / modelRate) * 1000)
      }
      stream.decodedSamples = reached
    }
    if (stream.resampledSamples - stream.reportedSamples >= COMMIT_AFTER_SECONDS * modelRate) {
      await commit(streamId, stream, 0)
    }
    const dropped = position(stream, 0) - stream.reportedSamples
    if (stream.span.samples === 0 && dropped >= SILENCE_COVERAGE_REPORT_SECONDS * modelRate) {
      report(streamId, stream, '', position(stream, 0))
    }
  }

  const noteDecodeSpeed = (stream: StreamCoverage, decodeMs: number, spokenMs: number) => {
    if (stream.slowPhraseDecodes >= SLOW_PHRASE_DECODES_BEFORE_NO_CUTS) {
      return
    }
    stream.slowPhraseDecodes = decodeMs > spokenMs ? stream.slowPhraseDecodes + 1 : 0
    if (stream.slowPhraseDecodes === SLOW_PHRASE_DECODES_BEFORE_NO_CUTS) {
      console.warn(
        '[speech] Phrases decode slower than they are spoken; this dictation cuts only at 30 s'
      )
    }
  }

  // Only pause-cut streams report it: without the detector, nothing tells speech from silence.
  const notePendingSpeech = (streamId: string, stream: StreamCoverage, pending: boolean) => {
    if (stream.vad && stream.speechPending !== pending) {
      stream.speechPending = pending
      post({ type: 'speech-pending', streamId, pending })
    }
  }

  const feedLive = async (
    streamId: string,
    stream: StreamCoverage,
    live: LiveDecode,
    samples: Float32Array
  ) => {
    if (canceled.has(streamId)) {
      return
    }
    const update = await live.feed(samples, stream.resampledSamples)
    if (update?.type === 'partial') {
      post({ type: 'partial', streamId, text: update.text })
    } else if (update) {
      const silence =
        update.covered - stream.reportedSamples >= SILENCE_COVERAGE_REPORT_SECONDS * modelRate
      if (update.text || silence) {
        report(streamId, stream, update.text, update.covered)
      }
    }
    const held = (stream.resampledSamples - stream.reportedSamples) / modelRate
    if (held >= LIVE_COMMIT_BY_SECONDS || (held >= COMMIT_AFTER_SECONDS && live.atPause)) {
      await endLive(streamId, stream)
    }
  }

  // At stop, or when another dictation needs the model.
  const endLive = async (streamId: string, stream: StreamCoverage) => {
    const text = await stream.live?.end(!canceled.has(streamId))
    if (text != null && !canceled.has(streamId)) {
      report(streamId, stream, text, stream.resampledSamples)
    }
  }

  const closeStream = (streamId: string): StreamCoverage | undefined => {
    const stream = streams.get(streamId)
    streams.delete(streamId)
    return stream
  }

  // The first decode compiles GPU pipelines (seconds on Metal); pay it while loading, not on the first stop.
  await (model.capabilities.supportsStreaming
    ? warmUpLiveDecode(session, baseOptions, modelRate)
    : transcribeChunk(new Float32Array(Math.round(modelRate / 2)), baseOptions))

  return {
    open(streamId, vocabulary) {
      openStream(streamId, vocabulary)
    },
    async feed(streamId, samples, sampleRate) {
      const stream = streams.get(streamId) ?? openStream(streamId, [])
      // The binding borrows PCM until the run settles; resampleToRate may return the caller's buffer.
      const resampled = new Float32Array(
        resampleToRate(samples, sampleRate || modelRate, modelRate)
      )
      stream.inputSamples += samples.length
      stream.resampledSamples += resampled.length
      if (stream.live) {
        await feedLive(streamId, stream, stream.live, resampled)
        return
      }
      const phrases = await stream.segmenter.push(resampled)
      // A cut phrase stays pending until its text is posted.
      notePendingSpeech(streamId, stream, phrases.length > 0 || !!stream.segmenter.phraseOpen)
      // Only beside a live dictation, whose native stream each decode ends, so this one decodes only to commit.
      const phraseText = !model.capabilities.supportsStreaming
      await decode(streamId, stream, phrases, phraseText)
      const textless = !phraseText && stream.span.samples > 0
      notePendingSpeech(streamId, stream, !!stream.segmenter.phraseOpen || textless)
    },
    async finish(streamId) {
      const stream = closeStream(streamId)
      if (!stream) {
        return
      }
      try {
        if (stream.live) {
          await endLive(streamId, stream)
          return
        }
        await decode(streamId, stream, await stream.segmenter.flush(), false)
        await commit(streamId, stream, 0)
        notePendingSpeech(streamId, stream, false)
      } finally {
        dropStream(stream)
      }
    },
    discard(streamId) {
      canceled.delete(streamId)
      const stream = closeStream(streamId)
      if (stream) {
        dropStream(stream)
      }
    },
    cancel(streamId) {
      canceled.add(streamId)
    }
  }
}
