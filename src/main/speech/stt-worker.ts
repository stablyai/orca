/* oxlint-disable typescript-eslint/no-explicit-any -- sherpa-onnx native addon has no type definitions */
import { parentPort, workerData } from 'node:worker_threads'
import { readdirSync } from 'node:fs'
import { resampleToRate } from './stt-audio-resample'
import { OfflineAudioChunker } from './stt-offline-audio-chunker'

type WorkerMessage =
  | {
      type: 'init'
      modelDir: string
      modelType: string
      streaming: boolean
      sampleRate: number
      files: string[]
      hotwordsFilePath?: string
      modelingUnit?: string
    }
  | { type: 'feed'; samples: Float32Array; sampleRate: number }
  | { type: 'stop' }
  | { type: 'teardown' }

// Why: the main sherpa-onnx npm package uses WASM which cannot access the host
// filesystem to load model files. We use the platform-specific native addon
// (e.g. sherpa-onnx-darwin-arm64) which has a flat C-style API and direct
// filesystem access. The main thread resolves the correct absolute path
// (dev vs packaged) and passes it via workerData.
let sherpa: any = null
let recognizer: any = null
let stream: any = null
let isStreaming = false
let offlineChunker: OfflineAudioChunker | null = null
let offlineSampleRate = 16000

function loadSherpa(): any {
  const modulePath = workerData?.sherpaModulePath
  if (!modulePath) {
    throw new Error('workerData.sherpaModulePath is required')
  }
  return require(modulePath)
}

// Why: different models name their ONNX files differently (e.g.
// encoder.int8.onnx vs tiny-encoder.onnx vs encoder-epoch-99-avg-1.onnx).
// We resolve the actual path from the manifest's files list by searching
// for the role name anywhere in the filename.
function resolveFile(files: string[], role: string, modelDir: string, ext = '.onnx'): string {
  const match = files.find((f) => f.includes(role) && f.endsWith(ext))
  if (!match) {
    throw new Error(`No *${role}*${ext} found in model files: ${files.join(', ')}`)
  }
  return `${modelDir}/${match}`
}

function resolveTokens(files: string[], modelDir: string): string {
  const match = files.find((f) => f.endsWith('tokens.txt'))
  if (!match) {
    throw new Error(`No *tokens.txt found in model files: ${files.join(', ')}`)
  }
  return `${modelDir}/${match}`
}

// Why: BPE models need a vocab file for hotwords token matching. The file
// ships in the model archive but isn't listed in the manifest. We discover
// it at runtime to avoid breaking existing downloads.
function discoverBpeVocab(modelDir: string): string | undefined {
  try {
    const entries = readdirSync(modelDir)
    const vocabFile = entries.find((f) => f.endsWith('.vocab'))
    return vocabFile ? `${modelDir}/${vocabFile}` : undefined
  } catch {
    return undefined
  }
}

function buildHotwordsConfig(msg: Extract<WorkerMessage, { type: 'init' }>): {
  decodingMethod: string
  hotwordsFile?: string
  hotwordsScore?: number
  modelingUnit?: string
  bpeVocab?: string
} {
  if (msg.modelType !== 'transducer' || !msg.hotwordsFilePath) {
    return { decodingMethod: 'greedy_search' }
  }

  const unit = msg.modelingUnit
  if (unit?.includes('bpe')) {
    const bpeVocab = discoverBpeVocab(msg.modelDir)
    if (!bpeVocab) {
      return { decodingMethod: 'greedy_search' }
    }
    return {
      decodingMethod: 'modified_beam_search',
      hotwordsFile: msg.hotwordsFilePath,
      hotwordsScore: 1.5,
      modelingUnit: unit,
      bpeVocab
    }
  }

  return {
    decodingMethod: 'modified_beam_search',
    hotwordsFile: msg.hotwordsFilePath,
    hotwordsScore: 1.5,
    modelingUnit: unit
  }
}

function handleInit(msg: Extract<WorkerMessage, { type: 'init' }>): void {
  try {
    sherpa = loadSherpa()

    const { modelDir, modelType, streaming, sampleRate, files } = msg
    isStreaming = streaming
    offlineChunker = streaming ? null : new OfflineAudioChunker(sampleRate)
    offlineSampleRate = sampleRate

    const tokens = resolveTokens(files, modelDir)
    const hotwords = buildHotwordsConfig(msg)

    if (streaming && modelType === 'transducer') {
      const config = {
        featConfig: { sampleRate, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: resolveFile(files, 'encoder', modelDir),
            decoder: resolveFile(files, 'decoder', modelDir),
            joiner: resolveFile(files, 'joiner', modelDir)
          },
          tokens,
          numThreads: 1,
          provider: 'cpu',
          debug: 0
        },
        ...hotwords,
        enableEndpoint: 1,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 20
      }
      recognizer = sherpa.createOnlineRecognizer(config)
      stream = sherpa.createOnlineStream(recognizer)
    } else if (streaming && modelType === 'paraformer') {
      const config = {
        featConfig: { sampleRate, featureDim: 80 },
        modelConfig: {
          paraformer: {
            encoder: resolveFile(files, 'encoder', modelDir),
            decoder: resolveFile(files, 'decoder', modelDir)
          },
          tokens,
          numThreads: 1,
          provider: 'cpu',
          debug: 0
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: 1,
        rule1MinTrailingSilence: 2.4,
        rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 20
      }
      recognizer = sherpa.createOnlineRecognizer(config)
      stream = sherpa.createOnlineStream(recognizer)
    } else if (modelType === 'whisper') {
      const config = {
        featConfig: { sampleRate, featureDim: 80 },
        modelConfig: {
          whisper: {
            encoder: resolveFile(files, 'encoder', modelDir),
            decoder: resolveFile(files, 'decoder', modelDir)
          },
          tokens,
          numThreads: 2,
          provider: 'cpu',
          debug: 0
        },
        decodingMethod: 'greedy_search'
      }
      recognizer = sherpa.createOfflineRecognizer(config)
      stream = sherpa.createOfflineStream(recognizer)
    } else {
      const config = {
        featConfig: { sampleRate, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: resolveFile(files, 'encoder', modelDir),
            decoder: resolveFile(files, 'decoder', modelDir),
            joiner: resolveFile(files, 'joiner', modelDir)
          },
          tokens,
          numThreads: 2,
          provider: 'cpu',
          debug: 0
        },
        ...hotwords
      }
      recognizer = sherpa.createOfflineRecognizer(config)
      stream = sherpa.createOfflineStream(recognizer)
    }

    parentPort?.postMessage({ type: 'ready' })
  } catch (err) {
    parentPort?.postMessage({ type: 'error', error: String(err) })
  }
}

// Why: an offline stream is single-use — decode one bounded chunk, then
// recreate the stream so the recognizer is ready for the next chunk.
function decodeOfflineChunk(samples: Float32Array): string {
  sherpa.acceptWaveformOffline(stream, { sampleRate: offlineSampleRate, samples })
  sherpa.decodeOfflineStream(recognizer, stream)
  const resultJson = sherpa.getOfflineStreamResultAsJson(stream)
  stream = sherpa.createOfflineStream(recognizer)
  const result = JSON.parse(resultJson)
  return result?.text?.trim() ?? ''
}

function handleFeed(msg: Extract<WorkerMessage, { type: 'feed' }>): void {
  if (!recognizer || !stream) {
    return
  }

  try {
    const inputRate = msg.sampleRate || offlineSampleRate
    // Why: sherpa's native stream aborts the process if one recognizer sees
    // different input rates across chunks. Normalize before crossing the
    // native boundary so device/context changes become recoverable JS state.
    const samples = resampleToRate(msg.samples, inputRate, offlineSampleRate)
    if (isStreaming) {
      sherpa.acceptWaveformOnline(stream, { sampleRate: offlineSampleRate, samples })

      while (sherpa.isOnlineStreamReady(recognizer, stream)) {
        sherpa.decodeOnlineStream(recognizer, stream)
      }

      const resultJson = sherpa.getOnlineStreamResultAsJson(recognizer, stream)
      const result = JSON.parse(resultJson)
      const text = result?.text?.trim()
      if (text) {
        parentPort?.postMessage({ type: 'partial', text })
      }

      if (sherpa.isEndpoint(recognizer, stream)) {
        const finalText = result?.text?.trim()
        if (finalText) {
          parentPort?.postMessage({ type: 'final', text: finalText })
        }
        sherpa.reset(recognizer, stream)
      }
    } else {
      // Why: decoding one unbounded capture in a single call makes ONNX tensor
      // sizes scale with dictation length until a >=2 GiB allocation SIGTRAPs
      // the whole app (#7925). Decode bounded chunks as they fill instead;
      // each consumer already appends multiple 'final' segments per session.
      const readyChunks = offlineChunker?.push(new Float32Array(samples)) ?? []
      for (const chunk of readyChunks) {
        const text = decodeOfflineChunk(chunk)
        if (text) {
          parentPort?.postMessage({ type: 'final', text })
        }
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
      stream = sherpa.createOnlineStream(recognizer)
    } else {
      // Why: the remainder is below the chunk limit by construction, so this
      // last decode is bounded too.
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
  }

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
    case 'teardown':
      handleTeardown()
      break
  }
})
