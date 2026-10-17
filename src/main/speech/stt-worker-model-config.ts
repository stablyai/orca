import { readdirSync } from 'node:fs'
import { join } from 'node:path'

// Why: different models name their ONNX files differently (e.g.
// encoder.int8.onnx vs tiny-encoder.onnx vs encoder-epoch-99-avg-1.onnx).
// We resolve the actual path from the manifest's files list by searching
// for the role name anywhere in the filename.
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

// Why: BPE models need a vocab file for hotwords token matching, but older caches may omit it.
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

export type RecognizerInit = {
  modelDir: string
  modelType: string
  streaming: boolean
  sampleRate: number
  files: string[]
  hotwordsFilePath?: string
  modelingUnit?: string
}

const ENDPOINT_RULES = {
  enableEndpoint: 1,
  rule1MinTrailingSilence: 2.4,
  rule2MinTrailingSilence: 1.2,
  rule3MinUtteranceLength: 20
}

// Why: each sherpa model family takes a differently shaped modelConfig, and only
// transducer/paraformer have an online recognizer — the caller picks the API from `online`.
export function buildRecognizerConfig(msg: RecognizerInit): {
  online: boolean
  config: Record<string, unknown>
} {
  const { modelDir, modelType, streaming, sampleRate, files } = msg
  // Why: Qwen3-ASR carries a BPE tokenizer directory instead of a tokens.txt.
  const tokens = modelType === 'qwen3-asr' ? '' : resolveTokens(files, modelDir)
  const featConfig = { sampleRate, featureDim: 80 }
  const shared = { tokens, provider: 'cpu', debug: 0 }

  if (streaming && modelType === 'transducer') {
    return {
      online: true,
      config: {
        featConfig,
        modelConfig: {
          transducer: {
            encoder: resolveFile(files, 'encoder', modelDir),
            decoder: resolveFile(files, 'decoder', modelDir),
            joiner: resolveFile(files, 'joiner', modelDir)
          },
          ...shared,
          numThreads: 1
        },
        ...buildHotwordsConfig(msg),
        ...ENDPOINT_RULES
      }
    }
  }

  if (streaming && modelType === 'paraformer') {
    return {
      online: true,
      config: {
        featConfig,
        modelConfig: {
          paraformer: {
            encoder: resolveFile(files, 'encoder', modelDir),
            decoder: resolveFile(files, 'decoder', modelDir)
          },
          ...shared,
          numThreads: 1
        },
        decodingMethod: 'greedy_search',
        ...ENDPOINT_RULES
      }
    }
  }

  const offline = (modelConfig: Record<string, unknown>, rest: Record<string, unknown>) => ({
    online: false,
    config: {
      featConfig,
      modelConfig: { ...modelConfig, ...shared, numThreads: 2 },
      ...rest
    }
  })

  if (modelType === 'whisper') {
    return offline(
      {
        whisper: {
          encoder: resolveFile(files, 'encoder', modelDir),
          decoder: resolveFile(files, 'decoder', modelDir)
        }
      },
      { decodingMethod: 'greedy_search' }
    )
  }

  if (modelType === 'nemo-ctc') {
    return offline(
      { nemoCtc: { model: resolveFile(files, 'model', modelDir) } },
      { decodingMethod: 'greedy_search' }
    )
  }

  if (modelType === 'senseVoice') {
    return offline(
      {
        senseVoice: {
          model: resolveFile(files, 'model', modelDir),
          // Empty string = auto-detect language (supports zh/en/ja/ko/yue).
          language: '',
          useInverseTextNormalization: 1
        }
      },
      { decodingMethod: 'greedy_search' }
    )
  }

  if (modelType === 'qwen3-asr') {
    return offline(
      {
        qwen3Asr: {
          convFrontend: resolveFile(files, 'conv_frontend', modelDir),
          encoder: resolveFile(files, 'encoder', modelDir),
          decoder: resolveFile(files, 'decoder', modelDir),
          // Why: sherpa reads vocab.json/merges.txt from this directory; the
          // download layout keeps them flat beside the ONNX files.
          tokenizer: modelDir,
          hotwords: ''
        }
      },
      { decodingMethod: 'greedy_search' }
    )
  }

  return offline(
    {
      transducer: {
        encoder: resolveFile(files, 'encoder', modelDir),
        decoder: resolveFile(files, 'decoder', modelDir),
        joiner: resolveFile(files, 'joiner', modelDir)
      }
    },
    buildHotwordsConfig(msg)
  )
}
