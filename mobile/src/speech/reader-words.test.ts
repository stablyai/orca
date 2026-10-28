import { describe, expect, it } from 'vitest'
import { pickReaderLanguage, READER_WORDS } from './reader-words'

describe('pickReaderLanguage', () => {
  it("follows the voice's language, not the phone's", () => {
    expect(pickReaderLanguage('pl-PL', 'en-US')).toBe('pl')
    expect(pickReaderLanguage('en-GB', 'pl-PL')).toBe('en')
    expect(pickReaderLanguage('pt_BR', 'en-US')).toBe('pt')
    expect(pickReaderLanguage('zh-Hans-CN', 'en-US')).toBe('zh')
  })

  it('says English in a voice it has no words for', () => {
    expect(pickReaderLanguage('it-IT', 'pl-PL')).toBe('en')
  })

  it("falls back to the phone's language while the voice's is unknown", () => {
    expect(pickReaderLanguage(null, 'pl-PL')).toBe('pl')
    expect(pickReaderLanguage(null, 'de-DE')).toBe('en')
    expect(pickReaderLanguage(null, null)).toBe('en')
  })

  it('does not take an inherited property for a language', () => {
    expect(pickReaderLanguage('constructor', null)).toBe('en')
  })

  it('has every word in every language', () => {
    const keys = Object.keys(READER_WORDS.en).sort()
    for (const words of Object.values(READER_WORDS)) {
      expect(Object.keys(words).sort()).toEqual(keys)
      expect(Object.values(words).every((word) => word.trim().length > 0)).toBe(true)
    }
  })
})
