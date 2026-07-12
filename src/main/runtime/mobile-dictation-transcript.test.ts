import { describe, expect, it } from 'vitest'
import {
  appendMobileDictationFinal,
  finishMobileDictationText
} from './mobile-dictation-transcript'

describe('mobile dictation transcript', () => {
  it('preserves streaming whitespace and punctuation fragments exactly', () => {
    const fragments: string[] = []
    for (const text of ['Hello', ',', ' ', 'world', '!']) {
      appendMobileDictationFinal(fragments, text, true)
    }

    expect(finishMobileDictationText(fragments, '', true)).toBe('Hello, world!')
  })

  it('adds a boundary for word-only local model segments', () => {
    const fragments: string[] = []
    appendMobileDictationFinal(fragments, 'hello', false)
    appendMobileDictationFinal(fragments, 'world', false)

    expect(finishMobileDictationText(fragments, '', false)).toBe('hello world')
  })

  it('does not inject spaces into CJK fragments', () => {
    const fragments: string[] = []
    appendMobileDictationFinal(fragments, '你好', false)
    appendMobileDictationFinal(fragments, '世界', false)

    expect(finishMobileDictationText(fragments, '！', false)).toBe('你好世界！')
  })

  it('keeps leading, trailing, and whitespace-only Soniox fragments', () => {
    const fragments: string[] = []
    for (const text of [' ', 'hello', ' ']) {
      appendMobileDictationFinal(fragments, text, true)
    }

    expect(finishMobileDictationText(fragments, ' ', true)).toBe(' hello  ')
  })
})
