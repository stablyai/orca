import { describe, expect, it } from 'vitest'
import { grokRequest } from './grok-requests'

describe('Grok question replies', () => {
  const presentation = grokRequest('x.ai/ask_user_question', {
    sessionId: 'session-1',
    toolCallId: 'tool-1',
    questions: [
      { question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
      { question: 'Which features?', multiSelect: true, options: [{ label: 'Auth' }] },
      { question: 'Which region?', options: [{ label: 'US' }] }
    ]
  })!

  it('leaves skipped questions out of a partly answered reply, as Grok does', () => {
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: ['o2'] },
          { questionId: 'q2', optionIds: [] },
          { questionId: 'q3', optionIds: [], other: 'EU' }
        ]
      })
    ).toEqual({
      outcome: 'accepted',
      answers: { 'Which database?': 'SQLite', 'Which region?': 'Other' },
      annotations: { 'Which region?': { notes: 'EU' } }
    })
  })

  it('refuses a reply with nothing answered', () => {
    expect(() =>
      presentation.reply({
        kind: 'answers',
        answers: ['q1', 'q2', 'q3'].map((questionId) => ({ questionId, optionIds: [] }))
      })
    ).toThrow()
  })
})
