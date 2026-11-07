import { existsSync, readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as TranscribeCpp from 'transcribe-cpp'
import { resampleToRate } from './stt-audio-resample'
import { OfflineAudioChunker } from './stt-offline-audio-chunker'
import { resolveFile } from './stt-worker-model-config'
import type { SttRecognizer, SttRecognizerInit, SttRecognizerPost } from './stt-recognizer'

// Past ~8 threads decode slowed 2-4x under load in the 2026-11 benchmark; E-cores and SMT siblings
// don't help. Half the logical CPUs is close to the performance cores on Apple silicon and SMT x86.
function performanceCoreThreads(): number {
  const logical = availableParallelism()
  return Math.min(logical, 8, Math.max(4, Math.floor(logical / 2)))
}

// The hotwords file is written in sherpa's format, one `term :score` per line. The host deletes it
// once dictation starts, so a CPU fallback's reload finds it gone and runs without.
function readVocabulary(path: string | undefined): string[] {
  if (!path || !existsSync(path)) {
    return []
  }
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\s+:[\d.]+\s*$/, '').trim())
    .filter(Boolean)
}

// Totals, not the nominal rate ratio: per-feed resampling rounds, and the drift would replay decoded audio.
type StreamCoverage = {
  chunker: OfflineAudioChunker
  inputSamples: number
  resampledSamples: number
  decodedSamples: number
}

export async function createTranscribeCppRecognizer(
  init: SttRecognizerInit,
  post: SttRecognizerPost
): Promise<SttRecognizer> {
  const entry = join(init.speechModulesDir, 'transcribe-cpp', 'dist', 'index.js')
  const transcribe: typeof TranscribeCpp = await import(pathToFileURL(entry).href)
  const model = await transcribe.TranscribeModel.load(
    resolveFile(init.files, '.gguf', init.modelDir, '.gguf')
  )
  // The child runs one call at a time, so every stream can share one session.
  const session = model.createSession({ nThreads: performanceCoreThreads() })
  const vocabulary = readVocabulary(init.hotwordsFilePath)
  const options: TranscribeCpp.TranscribeOptions = {
    timestamps: 'none',
    ...(init.language && model.capabilities.languages.includes(init.language)
      ? { language: init.language }
      : {}),
    ...(vocabulary.length > 0 && model.supports('vocabulary') ? { vocabulary } : {})
  }
  const modelRate = model.capabilities.nativeSampleRate || init.sampleRate
  const streams = new Map<string, StreamCoverage>()

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
  const decode = async (streamId: string, stream: StreamCoverage, chunk: Float32Array) => {
    const text = await transcribeChunk(chunk)
    stream.decodedSamples += chunk.length
    post({
      type: 'chunk',
      streamId,
      text: text.trim(),
      samples: Math.round((stream.decodedSamples * stream.inputSamples) / stream.resampledSamples)
    })
  }

  return {
    async feed(streamId, samples, sampleRate) {
      let stream = streams.get(streamId)
      if (!stream) {
        stream = {
          chunker: new OfflineAudioChunker(modelRate),
          inputSamples: 0,
          resampledSamples: 0,
          decodedSamples: 0
        }
        streams.set(streamId, stream)
      }
      // The binding borrows PCM until the run settles; resampleToRate may return the caller's buffer.
      const resampled = new Float32Array(
        resampleToRate(samples, sampleRate || modelRate, modelRate)
      )
      stream.inputSamples += samples.length
      stream.resampledSamples += resampled.length
      for (const chunk of stream.chunker.push(resampled)) {
        await decode(streamId, stream, chunk)
      }
    },
    async finish(streamId) {
      const stream = streams.get(streamId)
      streams.delete(streamId)
      const remaining = stream?.chunker.flush()
      if (stream && remaining) {
        await decode(streamId, stream, remaining)
      }
    },
    discard(streamId) {
      streams.delete(streamId)
    }
  }
}
