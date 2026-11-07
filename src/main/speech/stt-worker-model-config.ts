import { readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

// ONNX filenames vary by model; find each role in the manifest.
export function resolveFile(
  files: string[],
  role: string,
  modelDir: string,
  ext = '.onnx'
): string {
  const match = files.find((f) => f.includes(role) && f.endsWith(ext))
  if (!match) {
    throw new Error(`No *${role}*${ext} found in model files: ${files.join(', ')}`)
  }
  return join(modelDir, match)
}

export function resolveTokens(files: string[], modelDir: string): string {
  const match = files.find((f) => f.endsWith('tokens.txt'))
  if (!match) {
    throw new Error(`No *tokens.txt found in model files: ${files.join(', ')}`)
  }
  return join(modelDir, match)
}

// BPE hotword matching needs a vocab file that older caches may lack.
function discoverBpeVocab(modelDir: string): string | undefined {
  try {
    const entries = readdirSync(modelDir)
    const vocabFile = entries.find((f) => f.endsWith('.vocab'))
    return vocabFile ? join(modelDir, vocabFile) : undefined
  } catch {
    return undefined
  }
}

export type HotwordsConfig = {
  decodingMethod: string
  hotwordsFile?: string
  hotwordsScore?: number
  modelingUnit?: string
  bpeVocab?: string
}

export function buildHotwordsConfig(opts: {
  modelDir: string
  modelType: string
  hotwordsFilePath?: string
  modelingUnit?: string
}): HotwordsConfig {
  if (opts.modelType !== 'transducer' || !opts.hotwordsFilePath) {
    return { decodingMethod: 'greedy_search' }
  }

  const unit = opts.modelingUnit
  if (unit?.includes('bpe')) {
    const bpeVocab = discoverBpeVocab(opts.modelDir)
    if (!bpeVocab) {
      return { decodingMethod: 'greedy_search' }
    }
    return {
      decodingMethod: 'modified_beam_search',
      hotwordsFile: opts.hotwordsFilePath,
      hotwordsScore: 1.5,
      modelingUnit: unit,
      bpeVocab
    }
  }

  return {
    decodingMethod: 'modified_beam_search',
    hotwordsFile: opts.hotwordsFilePath,
    hotwordsScore: 1.5,
    modelingUnit: unit
  }
}

export type RecognizerConfigInput = {
  modelDir: string
  modelType: string
  streaming: boolean
  sampleRate: number
  files: string[]
  hotwordsFilePath?: string
  modelingUnit?: string
  // Absent = auto-detect; only Whisper and SenseVoice read it.
  language?: string
}

// The user waits on offline decode at stop (and per 30 s chunk); 4 threads cut it ~35% at equal memory.
const OFFLINE_NUM_THREADS = Math.min(4, availableParallelism())

// Online configs go to createOnlineRecognizer, the rest to createOfflineRecognizer.
export function buildRecognizerConfig(msg: RecognizerConfigInput): {
  online: boolean
  config: Record<string, unknown>
} {
  const { modelDir, modelType, streaming, sampleRate, files } = msg
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
    return { online: true, config }
  }
  if (streaming && modelType === 'paraformer') {
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
    return { online: true, config }
  }
  if (modelType === 'whisper') {
    const config = {
      featConfig: { sampleRate, featureDim: 80 },
      modelConfig: {
        whisper: {
          encoder: resolveFile(files, 'encoder', modelDir),
          decoder: resolveFile(files, 'decoder', modelDir),
          language: msg.language ?? ''
        },
        tokens,
        numThreads: OFFLINE_NUM_THREADS,
        provider: 'cpu',
        debug: 0
      },
      decodingMethod: 'greedy_search'
    }
    return { online: false, config }
  }
  if (modelType === 'nemo-ctc') {
    const config = {
      featConfig: { sampleRate, featureDim: 80 },
      modelConfig: {
        nemoCtc: {
          model: resolveFile(files, 'model', modelDir)
        },
        tokens,
        numThreads: OFFLINE_NUM_THREADS,
        provider: 'cpu',
        debug: 0
      },
      decodingMethod: 'greedy_search'
    }
    return { online: false, config }
  }
  if (modelType === 'senseVoice') {
    const config = {
      featConfig: { sampleRate, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: resolveFile(files, 'model', modelDir),
          language: msg.language ?? '',
          useInverseTextNormalization: 1
        },
        tokens,
        numThreads: OFFLINE_NUM_THREADS,
        provider: 'cpu',
        debug: 0
      },
      decodingMethod: 'greedy_search'
    }
    return { online: false, config }
  }
  const config = {
    featConfig: { sampleRate, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: resolveFile(files, 'encoder', modelDir),
        decoder: resolveFile(files, 'decoder', modelDir),
        joiner: resolveFile(files, 'joiner', modelDir)
      },
      tokens,
      numThreads: OFFLINE_NUM_THREADS,
      provider: 'cpu',
      debug: 0
    },
    ...hotwords
  }
  return { online: false, config }
}
