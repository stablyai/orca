import { readFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as TranscribeCpp from 'transcribe-cpp'
import { resampleToRate } from './stt-audio-resample'
import { OfflineAudioChunker } from './stt-offline-audio-chunker'
import { VadPauseSegmenter } from './stt-vad-pause-segmenter'
import type { SttRecognizer, SttRecognizerInit, SttRecognizerPost } from './stt-recognizer'

// Past ~8 threads decode slowed 2-4x under load in the 2026-11 benchmark; E-cores and SMT siblings
// don't help. Half the logical CPUs is close to the performance cores on Apple silicon and SMT x86.
function performanceCoreThreads(): number {
  const logical = availableParallelism()
  return Math.min(logical, 8, Math.max(4, Math.floor(logical / 2)))
}

// One term per line. The host deletes the file once dictation starts, so a CPU fallback's reload
// finds it gone and runs without.
async function readVocabulary(path: string | undefined): Promise<string[]> {
  const text = path ? await readFile(path, 'utf8').catch(() => '') : ''
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

// Without the detector, audio is still cut at the decode bound, just not at pauses.
type AudioSegmenter = {
  readonly heldSamples: number
  push(samples: Float32Array): Float32Array[] | Promise<Float32Array[]>
  flush(): Float32Array[] | Promise<Float32Array[]>
}

function boundedChunks(sampleRate: number): AudioSegmenter {
  const chunker = new OfflineAudioChunker(sampleRate)
  return {
    get heldSamples() {
      return chunker.heldSamples
    },
    push: (samples) => chunker.push(samples),
    flush: () => {
      const rest = chunker.flush()
      return rest ? [rest] : []
    }
  }
}

// Totals, not the nominal rate ratio: per-feed resampling rounds, and the drift would replay decoded audio.
type StreamCoverage = {
  segmenter: AudioSegmenter
  vad: TranscribeCpp.VadSession | null
  inputSamples: number
  resampledSamples: number
  reportedSamples: number
  slowPhraseDecodes: number
}

// Whisper pads every decode to a 30 s window, so each phrase costs a full decode. Where that takes longer than the
// speech (and silence) it covers, per-pause decodes queue up behind the speaker, so that dictation stops cutting.
// Two in a row, so one slow first run or load spike doesn't.
const SLOW_PHRASE_DECODES_BEFORE_NO_CUTS = 2

// Dropped silence still counts as covered; report it so the host's replay buffer and stall watch don't grow through long pauses.
const SILENCE_COVERAGE_REPORT_SECONDS = 5

// Optional: without it dictation still works, with text only at the decode bound and at stop.
async function loadSileroVad(
  transcribe: typeof TranscribeCpp,
  path: string | undefined,
  sampleRate: number
): Promise<TranscribeCpp.TranscribeModel | null> {
  if (!path) {
    return null
  }
  try {
    // Tiny and per-frame; the CPU keeps it off a GPU that may fail over.
    const model = await transcribe.TranscribeModel.load(path, { backend: 'cpu' })
    if (model.vadInfo.sampleRate === sampleRate) {
      return model
    }
    console.warn(
      `[speech] Silero VAD needs ${model.vadInfo.sampleRate} Hz; this model takes ${sampleRate} Hz`
    )
    model.dispose()
  } catch (error) {
    console.warn('[speech] Silero VAD unavailable; text arrives at stop:', error)
  }
  return null
}

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
  const model = await transcribe.TranscribeModel.load(join(init.modelDir, gguf))
  // The child runs one call at a time, so every stream can share one session.
  const session = model.createSession({ nThreads: performanceCoreThreads() })
  const vocabulary = await readVocabulary(init.hotwordsFilePath)
  const { languages } = model.capabilities
  // The setting is ISO-639-1; Nemotron names locales (ko-KR) and rejects the bare code.
  const language = init.language
    ? (languages.find((code) => code === init.language) ??
      languages.find((code) => code.startsWith(`${init.language}-`)))
    : undefined
  const options: TranscribeCpp.TranscribeOptions = {
    timestamps: 'none',
    ...(language ? { language } : {}),
    ...(vocabulary.length > 0 && model.supports('vocabulary') ? { vocabulary } : {})
  }
  const modelRate = model.capabilities.nativeSampleRate || init.sampleRate
  const vadModel = await loadSileroVad(transcribe, init.vadModelPath, modelRate)
  const streams = new Map<string, StreamCoverage>()
  const openStream = (): StreamCoverage => {
    // A VAD stream is per-dictation state, so each dictation gets its own session.
    const vad = vadModel?.createVadSession({ nThreads: 1 }) ?? null
    const stream: StreamCoverage = {
      segmenter: boundedChunks(modelRate),
      vad,
      inputSamples: 0,
      resampledSamples: 0,
      reportedSamples: 0,
      slowPhraseDecodes: 0
    }
    if (vad && vadModel) {
      stream.segmenter = new VadPauseSegmenter(
        vad,
        modelRate,
        vadModel.vadInfo.frameSamples,
        () => stream.slowPhraseDecodes < SLOW_PHRASE_DECODES_BEFORE_NO_CUTS
      )
    }
    return stream
  }

  const transcribeChunk = async (chunk: Float32Array): Promise<string> => {
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

  // The first run compiles GPU pipelines (seconds on Metal); pay it while loading, not on the first stop.
  await transcribeChunk(new Float32Array(Math.round(modelRate / 2)))

  // Coverage is in input-rate samples so the host can trim the audio it keeps for a CPU replay.
  const report = (streamId: string, stream: StreamCoverage, text: string, undecoded: number) => {
    const covered = stream.resampledSamples - stream.segmenter.heldSamples - undecoded
    stream.reportedSamples = covered
    post({
      type: 'chunk',
      streamId,
      text,
      samples: Math.round((covered * stream.inputSamples) / stream.resampledSamples)
    })
  }

  const decode = async (streamId: string, stream: StreamCoverage, chunks: Float32Array[]) => {
    let undecoded = chunks.reduce((total, chunk) => total + chunk.length, 0)
    for (const chunk of chunks) {
      const startedAt = performance.now()
      const text = await transcribeChunk(chunk)
      const decodeMs = performance.now() - startedAt
      const spokenSince = stream.reportedSamples
      undecoded -= chunk.length
      report(streamId, stream, text.trim(), undecoded)
      if (stream.vad) {
        noteDecodeSpeed(
          stream,
          decodeMs,
          ((stream.reportedSamples - spokenSince) / modelRate) * 1000
        )
      }
    }
    const dropped = stream.resampledSamples - stream.segmenter.heldSamples - stream.reportedSamples
    if (dropped >= SILENCE_COVERAGE_REPORT_SECONDS * modelRate) {
      report(streamId, stream, '', 0)
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

  const closeStream = (streamId: string): StreamCoverage | undefined => {
    const stream = streams.get(streamId)
    streams.delete(streamId)
    return stream
  }

  return {
    async feed(streamId, samples, sampleRate) {
      let stream = streams.get(streamId)
      if (!stream) {
        stream = openStream()
        streams.set(streamId, stream)
      }
      // The binding borrows PCM until the run settles; resampleToRate may return the caller's buffer.
      const resampled = new Float32Array(
        resampleToRate(samples, sampleRate || modelRate, modelRate)
      )
      stream.inputSamples += samples.length
      stream.resampledSamples += resampled.length
      await decode(streamId, stream, await stream.segmenter.push(resampled))
    },
    async finish(streamId) {
      const stream = closeStream(streamId)
      if (!stream) {
        return
      }
      try {
        await decode(streamId, stream, await stream.segmenter.flush())
      } finally {
        stream.vad?.dispose()
      }
    },
    discard(streamId) {
      closeStream(streamId)?.vad?.dispose()
    }
  }
}
