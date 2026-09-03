import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getCatalogModel } from './model-catalog'
import {
  buildOfflineTransducerRecognizerConfig,
  resolveFile,
  resolveTokens
} from './stt-worker-model-config'

const MODEL_DIR = join('models', 'test-model')

describe('resolveFile', () => {
  it('resolves an encoder/decoder/joiner triple by role name', () => {
    const files = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']

    expect(resolveFile(files, 'encoder', MODEL_DIR)).toBe(join(MODEL_DIR, 'encoder.int8.onnx'))
    expect(resolveFile(files, 'decoder', MODEL_DIR)).toBe(join(MODEL_DIR, 'decoder.int8.onnx'))
    expect(resolveFile(files, 'joiner', MODEL_DIR)).toBe(join(MODEL_DIR, 'joiner.int8.onnx'))
  })

  it('resolves a single fused model file for nemo-ctc-style manifests', () => {
    const files = ['model.int8.onnx', 'tokens.txt']

    expect(resolveFile(files, 'model', MODEL_DIR)).toBe(join(MODEL_DIR, 'model.int8.onnx'))
  })

  it('throws when no file matches the requested role', () => {
    const files = ['model.int8.onnx', 'tokens.txt']

    expect(() => resolveFile(files, 'joiner', MODEL_DIR)).toThrow(/No \*joiner\*\.onnx found/)
  })
})

describe('resolveTokens', () => {
  it('resolves tokens.txt regardless of surrounding files', () => {
    const files = ['model.int8.onnx', 'tokens.txt']

    expect(resolveTokens(files, MODEL_DIR)).toBe(join(MODEL_DIR, 'tokens.txt'))
  })

  it('throws when tokens.txt is missing', () => {
    const files = ['model.int8.onnx']

    expect(() => resolveTokens(files, MODEL_DIR)).toThrow(/No \*tokens\.txt found/)
  })
})

describe('buildOfflineTransducerRecognizerConfig', () => {
  const transducerFiles = ['encoder.int8.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']

  it('passes the model featureDim to the worker featConfig', () => {
    const config = buildOfflineTransducerRecognizerConfig({
      sampleRate: 16000,
      featureDim: 64,
      modelDir: MODEL_DIR,
      modelType: 'transducer',
      files: transducerFiles
    })

    expect(config.featConfig).toEqual({ sampleRate: 16000, featureDim: 64 })
    expect(config.modelConfig.transducer.encoder).toBe(join(MODEL_DIR, 'encoder.int8.onnx'))
  })

  it('falls back to 80 mel bins when the manifest omits featureDim', () => {
    const config = buildOfflineTransducerRecognizerConfig({
      sampleRate: 16000,
      modelDir: MODEL_DIR,
      modelType: 'transducer',
      files: transducerFiles
    })

    expect(config.featConfig).toEqual({ sampleRate: 16000, featureDim: 80 })
  })

  it('locks the catalog-to-worker chain for the GigaAM manifest', () => {
    const manifest = getCatalogModel('gigaam-v3-rnnt-ru')

    expect(manifest?.featureDim).toBe(64)
    const config = buildOfflineTransducerRecognizerConfig({
      sampleRate: manifest?.sampleRate ?? 16000,
      featureDim: manifest?.featureDim,
      modelDir: MODEL_DIR,
      modelType: manifest?.type ?? 'transducer',
      files: manifest?.files ?? []
    })

    expect(config.featConfig.featureDim).toBe(64)
  })
})
