import { describe, expect, it } from 'vitest'
import { resolveMobileDictationFinishResult } from './mobile-dictation-finish-result'

describe('resolveMobileDictationFinishResult', () => {
  it('uses corrected text when the runtime selected auto mode', () => {
    expect(
      resolveMobileDictationFinishResult(
        {
          text: '你好，Qwen3-ASR。',
          rawText: '你好 逗号 q w e n 3 a s r 句号',
          correctedText: '你好，Qwen3-ASR。',
          dictationCorrectionMode: 'auto'
        },
        'off'
      )
    ).toEqual({ text: '你好，Qwen3-ASR。', preview: null })
  })

  it('keeps the raw text recoverable when the runtime selected preview mode', () => {
    expect(
      resolveMobileDictationFinishResult(
        {
          text: 'q w e n 3 a s r comma ready',
          rawText: 'q w e n 3 a s r comma ready',
          correctedText: 'Qwen3-ASR, ready',
          dictationCorrectionMode: 'preview'
        },
        'off'
      )
    ).toEqual({
      text: 'q w e n 3 a s r comma ready',
      preview: {
        rawText: 'q w e n 3 a s r comma ready',
        correctedText: 'Qwen3-ASR, ready'
      }
    })
  })

  it('uses the legacy text field when paired with an older runtime', () => {
    expect(resolveMobileDictationFinishResult({ text: 'legacy transcript' }, 'preview')).toEqual({
      text: 'legacy transcript',
      preview: null
    })
  })

  it('treats an explicit runtime mode as authoritative over the mobile fallback', () => {
    expect(
      resolveMobileDictationFinishResult(
        {
          text: 'raw transcript',
          rawText: 'raw transcript',
          correctedText: 'corrected transcript',
          dictationCorrectionMode: 'off'
        },
        'auto'
      )
    ).toEqual({ text: 'raw transcript', preview: null })
  })
})
