import { describe, expect, it } from 'vitest'
import {
  formatQuestionAnswer,
  formatQuestionFreeTextAnswer,
  mobileChatQuestionKey,
  type MobileChatQuestion
} from './mobile-native-chat-question'

describe('formatQuestionAnswer', () => {
  const numbered: MobileChatQuestion = {
    question: 'Pick',
    options: ['Alpha', 'Beta', 'Gamma'],
    multiSelect: false,
    optionTokens: ['1', '2', '3']
  }

  it('echoes the leading token for single-select', () => {
    expect(formatQuestionAnswer(numbered, ['Beta'])).toBe('2')
  })

  it('comma-joins tokens for multi-select', () => {
    const multi: MobileChatQuestion = { ...numbered, multiSelect: true }
    expect(formatQuestionAnswer(multi, ['Alpha', 'Gamma'])).toBe('1, 3')
  })

  it('sends the label text when the option had no token (bullet list)', () => {
    const bullets: MobileChatQuestion = {
      question: 'Pick',
      options: ['Rebase', 'Merge'],
      multiSelect: false,
      optionTokens: [null, null]
    }
    expect(formatQuestionAnswer(bullets, ['Merge'])).toBe('Merge')
  })

  it('echoes letter tokens', () => {
    const lettered: MobileChatQuestion = {
      question: 'Pick',
      options: ['Alpha', 'Beta'],
      multiSelect: false,
      optionTokens: ['a', 'b']
    }
    expect(formatQuestionAnswer(lettered, ['Beta'])).toBe('b')
  })

  it('passes free-text / unknown entries through verbatim', () => {
    expect(formatQuestionAnswer(numbered, ['something custom'])).toBe('something custom')
  })

  it('returns empty string when nothing is selected', () => {
    expect(formatQuestionAnswer(numbered, [])).toBe('')
    expect(formatQuestionAnswer(numbered, ['   '])).toBe('')
  })

  it('prefixes free-text answers with an opaque prompt token when provided', () => {
    expect(
      formatQuestionFreeTextAnswer({ ...numbered, freeTextToken: 'target' }, '  hi there  ')
    ).toBe(`target:${encodeURIComponent('hi there')}`)
  })

  it('encodes empty and whitespace answers only when allowed', () => {
    const withInput: MobileChatQuestion = {
      ...numbered,
      freeTextToken: 'target',
      freeTextInput: { allowEmpty: true }
    }
    expect(formatQuestionFreeTextAnswer(withInput, '')).toBe('target:')
    expect(formatQuestionFreeTextAnswer(withInput, '  \n ')).toBe(
      `target:${encodeURIComponent('  \n ')}`
    )
    expect(formatQuestionFreeTextAnswer({ ...withInput, freeTextInput: undefined }, '  \n ')).toBe(
      ''
    )
  })
})

describe('mobileChatQuestionKey', () => {
  it('changes when a replacement prompt changes any positional content', () => {
    const first: MobileChatQuestion = {
      question: 'Pick',
      options: ['A', 'B'],
      multiSelect: true,
      optionTokens: ['1', '2']
    }
    expect(mobileChatQuestionKey({ ...first, options: ['A', 'C'] })).not.toBe(
      mobileChatQuestionKey(first)
    )
    expect(mobileChatQuestionKey({ ...first, freeTextToken: 'target-2' })).not.toBe(
      mobileChatQuestionKey(first)
    )
  })
})
