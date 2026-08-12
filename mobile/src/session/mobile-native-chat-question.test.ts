import { describe, expect, it } from 'vitest'
import {
  formatQuestionAnswer,
  mobileChatQuestionKey,
  parseAgentQuestion,
  type MobileChatQuestion
} from './mobile-native-chat-question'

describe('parseAgentQuestion', () => {
  it('parses a numbered list with a question line', () => {
    const text = ['Which database should I use?', '1. PostgreSQL', '2. MySQL', '3. SQLite'].join(
      '\n'
    )
    const q = parseAgentQuestion(text)
    expect(q).not.toBeNull()
    expect(q?.question).toBe('Which database should I use?')
    expect(q?.options).toEqual(['PostgreSQL', 'MySQL', 'SQLite'])
    expect(q?.optionTokens).toEqual(['1', '2', '3'])
    expect(q?.multiSelect).toBe(false)
  })

  it('parses numbered lists using ) markers', () => {
    const q = parseAgentQuestion('Pick:\n1) Yes\n2) No')
    expect(q?.options).toEqual(['Yes', 'No'])
    expect(q?.optionTokens).toEqual(['1', '2'])
  })

  it('parses a bulleted list', () => {
    const text = ['How should we proceed?', '- Rebase', '- Merge', '* Squash'].join('\n')
    const q = parseAgentQuestion(text)
    expect(q?.options).toEqual(['Rebase', 'Merge', 'Squash'])
    expect(q?.optionTokens).toEqual([null, null, null])
    expect(q?.question).toBe('How should we proceed?')
  })

  it('parses lettered options in brackets and parens', () => {
    const q = parseAgentQuestion('Choose one:\n[a] Alpha\n[b] Beta')
    expect(q?.options).toEqual(['Alpha', 'Beta'])
    expect(q?.optionTokens).toEqual(['a', 'b'])

    const q2 = parseAgentQuestion('Choose one:\na) Alpha\nb) Beta')
    expect(q2?.options).toEqual(['Alpha', 'Beta'])
    expect(q2?.optionTokens).toEqual(['a', 'b'])
  })

  it('strips a leading pointer/highlight glyph from the selected row', () => {
    const text = ['Select a target:', '❯ 1. main', '  2. develop'].join('\n')
    const q = parseAgentQuestion(text)
    expect(q?.options).toEqual(['main', 'develop'])
    expect(q?.optionTokens).toEqual(['1', '2'])
  })

  it('drops a trailing colon but keeps a question mark in the title', () => {
    expect(parseAgentQuestion('Options:\n1. A\n2. B')?.question).toBe('Options')
    expect(parseAgentQuestion('Ready?\n1. A\n2. B')?.question).toBe('Ready?')
  })

  it('returns null for ordinary prose with no option list', () => {
    expect(parseAgentQuestion('I finished the refactor and ran the tests.')).toBeNull()
    expect(parseAgentQuestion('')).toBeNull()
    expect(parseAgentQuestion('   ')).toBeNull()
  })

  it('returns null for a single bare option with no introducing prompt', () => {
    // A lone "- item" in prose must not be treated as a question.
    expect(parseAgentQuestion('Here is what I did:\nsome work\n- one stray bullet')).toBeNull()
  })

  it('accepts a single option when introduced by a prompt line', () => {
    const q = parseAgentQuestion('Apply this change?\n1. Yes, apply it')
    expect(q).not.toBeNull()
    expect(q?.options).toEqual(['Yes, apply it'])
  })

  it('uses a fallback title when no introducing line exists', () => {
    const q = parseAgentQuestion('1. Alpha\n2. Beta')
    expect(q?.question).toBe('Choose an option')
    expect(q?.options).toEqual(['Alpha', 'Beta'])
  })

  it('detects multi-select hints', () => {
    expect(parseAgentQuestion('Select all that apply:\n1. A\n2. B')?.multiSelect).toBe(true)
    expect(parseAgentQuestion('Choose multiple:\n- A\n- B')?.multiSelect).toBe(true)
    expect(parseAgentQuestion('Pick one:\n1. A\n2. B')?.multiSelect).toBe(false)
  })

  it('does not flag multi-select when only one option is present', () => {
    const q = parseAgentQuestion('Select all that apply?\n1. Only one')
    expect(q?.multiSelect).toBe(false)
  })

  it('finds the question line nearest the options, skipping blanks', () => {
    const text = ['Some preamble.', '', 'Which branch?', '', '1. main', '2. dev'].join('\n')
    const q = parseAgentQuestion(text)
    expect(q?.question).toBe('Which branch?')
  })
})

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
  })
})
