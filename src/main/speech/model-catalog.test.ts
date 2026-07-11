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
    expect(manifest?.archiveFormat).toBe('tar.bz2')
    expect(manifest?.sizeBytes).toBe(489_389_564)
    expect(manifest?.archiveSha256).toBe(
      '4b0a800ef29f4f4c8667339bf6f60d5bfdc2852ddc9dc5741aea65b6f8d1306b'
    )
  })

  it('has unique ids across the catalog', () => {
    const ids = SPEECH_MODEL_CATALOG.map((m) => m.id)

    expect(new Set(ids).size).toBe(ids.length)
  })
})
