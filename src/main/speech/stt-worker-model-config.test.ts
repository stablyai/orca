import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildRecognizerConfig, resolveFile, resolveTokens } from './stt-worker-model-config'

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

describe('buildRecognizerConfig', () => {
  const qwenFiles = [
    'conv_frontend.onnx',
    'encoder.int8.onnx',
    'decoder.int8.onnx',
    'vocab.json',
    'merges.txt',
    'tokenizer_config.json'
  ]

  it('points Qwen3-ASR at the model directory instead of a tokens.txt', () => {
    const { online, config } = buildRecognizerConfig({
      modelDir: MODEL_DIR,
      modelType: 'qwen3-asr',
      streaming: false,
      sampleRate: 16000,
      files: qwenFiles
    })

    expect(online).toBe(false)
    const modelConfig = config.modelConfig as Record<string, Record<string, unknown>>
    expect(modelConfig.qwen3Asr).toEqual({
      convFrontend: join(MODEL_DIR, 'conv_frontend.onnx'),
      encoder: join(MODEL_DIR, 'encoder.int8.onnx'),
      decoder: join(MODEL_DIR, 'decoder.int8.onnx'),
      tokenizer: MODEL_DIR,
      hotwords: ''
    })
    expect(modelConfig.tokens).toBe('')
  })

  it('keeps streaming transducers on the online recognizer with endpoint rules', () => {
    const { online, config } = buildRecognizerConfig({
      modelDir: MODEL_DIR,
      modelType: 'transducer',
      streaming: true,
      sampleRate: 16000,
      files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']
    })

    expect(online).toBe(true)
    expect(config.enableEndpoint).toBe(1)
    const modelConfig = config.modelConfig as Record<string, unknown>
    expect(modelConfig.numThreads).toBe(1)
    expect(modelConfig.tokens).toBe(join(MODEL_DIR, 'tokens.txt'))
  })

  it('falls back to the offline transducer layout for unknown model types', () => {
    const { online, config } = buildRecognizerConfig({
      modelDir: MODEL_DIR,
      modelType: 'transducer',
      streaming: false,
      sampleRate: 16000,
      files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']
    })

    expect(online).toBe(false)
    const modelConfig = config.modelConfig as Record<string, unknown>
    expect(modelConfig.numThreads).toBe(2)
    expect(modelConfig.transducer).toBeDefined()
  })
})
