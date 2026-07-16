import { describe, expect, it } from 'vitest'
import { SPEECH_MODEL_CATALOG, getCatalogModel } from './model-catalog'

describe('SPEECH_MODEL_CATALOG SenseVoice entry', () => {
  it('registers SenseVoice as a non-streaming local model', () => {
    const model = getCatalogModel('sense-voice-zh-en-ja-ko-yue')
    expect(model).toBeDefined()
    expect(model?.type).toBe('senseVoice')
    expect(model?.provider).toBe('local')
    expect(model?.streaming).toBe(false)
  })

  it('ships the single-file SenseVoice model layout the loader resolves', () => {
    const model = getCatalogModel('sense-voice-zh-en-ja-ko-yue')
    // stt-worker resolves the model via resolveFile(files, 'model') and
    // resolveTokens(files) — both must be present in this exact form.
    expect(model?.files).toEqual(['model.int8.onnx', 'tokens.txt'])
    expect(model?.archiveSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('downloads the upstream int8-only SenseVoice archive', () => {
    const model = getCatalogModel('sense-voice-zh-en-ja-ko-yue')
    expect(model?.sizeBytes).toBe(163_002_883)
    expect(model?.downloadUrl).toBe(
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2'
    )
    expect(model?.archiveSha256).toBe(
      '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e'
    )
  })

  it('is the only bundled local model advertising Korean support', () => {
    const korean = SPEECH_MODEL_CATALOG.filter(
      (m) => m.provider === 'local' && /\bkorean\b/i.test(m.description)
    )
    expect(korean.map((m) => m.id)).toEqual(['sense-voice-zh-en-ja-ko-yue'])
  })
})
