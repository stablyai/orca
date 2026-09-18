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

  it('includes offline Korean zipformer for accurate non-streaming dictation (#10103)', () => {
    const korean = getCatalogModel('zipformer-korean-2024-06-24')
    expect(korean).toMatchObject({
      language: 'ko',
      type: 'transducer',
      streaming: false,
      sizeBytes: 329_740_690,
      archiveSha256: '24bd409318f389cd2de0e295eb1acf91f4e8dfcc0d650490dd2a01f5b50d2c77'
    })
    expect(korean?.downloadUrl).toContain('sherpa-onnx-zipformer-korean-2024-06-24.tar.bz2')
    expect(korean?.files).toEqual([
      'encoder-epoch-99-avg-1.int8.onnx',
      'decoder-epoch-99-avg-1.int8.onnx',
      'joiner-epoch-99-avg-1.int8.onnx',
      'tokens.txt'
    ])
  })

  it('includes streaming Korean zipformer with a complete local file manifest', () => {
    const streaming = getCatalogModel('zipformer-streaming-korean')
    expect(streaming).toBeDefined()
    expect(streaming?.language).toBe('ko')
    expect(streaming?.type).toBe('transducer')
    expect(streaming?.streaming).toBe(true)
    expect(streaming?.files).toEqual([
      'encoder-epoch-99-avg-1.int8.onnx',
      'decoder-epoch-99-avg-1.int8.onnx',
      'joiner-epoch-99-avg-1.int8.onnx',
      'tokens.txt'
    ])
  })

})
