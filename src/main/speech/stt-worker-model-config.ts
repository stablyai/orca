import { join } from 'node:path'
import { findSpeechModelBpeVocabFile } from './speech-model-directory-scanner'

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

// Why: BPE models need a vocab file for hotwords token matching. The file
// ships in the model archive but isn't listed in the manifest. We discover
// it at runtime to avoid breaking existing downloads.
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
    const bpeVocab = findSpeechModelBpeVocabFile(opts.modelDir)
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
