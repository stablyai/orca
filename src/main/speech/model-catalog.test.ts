import { describe, expect, it } from 'vitest'
import { getCatalogModel, SPEECH_MODEL_CATALOG } from './model-catalog'

describe('SPEECH_MODEL_CATALOG', () => {
  it('includes the Japanese Parakeet TDT-CTC model with a valid manifest', () => {
    const manifest = getCatalogModel('parakeet-tdt-ctc-0.6b-ja-int8')

    expect(manifest).toBeDefined()
    expect(manifest?.type).toBe('nemo-ctc')
    expect(manifest?.provider).toBe('local')
    expect(manifest?.language).toBe('ja')
    expect(manifest?.streaming).toBe(false)
    expect(manifest?.sampleRate).toBe(16000)
    expect(manifest?.files).toEqual(['model.int8.onnx', 'tokens.txt'])
    expect(manifest?.sizeBytes).toBe(655_571_161)
    expect(manifest?.downloadFiles?.map(({ name }) => name)).toEqual([
      'model.int8.onnx',
      'tokens.txt'
    ])
  })

  it('has unique ids across the catalog', () => {
    const ids = SPEECH_MODEL_CATALOG.map((m) => m.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  it('registers SenseVoice as a non-streaming local model', () => {
    const model = getCatalogModel('sense-voice-zh-en-ja-ko-yue')
    expect(model).toBeDefined()
    expect(model?.type).toBe('senseVoice')
    expect(model?.provider).toBe('local')
    expect(model?.language).toBe('multilingual')
    expect(model?.streaming).toBe(false)
  })

  it('ships the single-file SenseVoice model layout the loader resolves', () => {
    const model = getCatalogModel('sense-voice-zh-en-ja-ko-yue')
    expect(model?.files).toEqual(['model.int8.onnx', 'tokens.txt'])
  })

  it('downloads only the pinned SenseVoice runtime files', () => {
    const model = getCatalogModel('sense-voice-zh-en-ja-ko-yue')
    expect(model?.sizeBytes).toBe(239_549_735)
    expect(model?.downloadFiles).toHaveLength(2)
    expect(model?.downloadFiles?.map(({ name }) => name)).toEqual(['model.int8.onnx', 'tokens.txt'])
  })
})
