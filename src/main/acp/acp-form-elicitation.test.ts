import { describe, expect, it } from 'vitest'
import { acpFormElicitationPresentation } from './acp-form-elicitation'

describe('OMP ask forms', () => {
  // Verbatim `elicitation/create` from OMP 18.16.0's `ask` with three questions.
  const ask = {
    mode: 'form',
    sessionId: 'session-1',
    message: 'Answer 3 questions',
    requestedSchema: {
      type: 'object',
      properties: {
        q0: {
          type: 'string',
          title: 'Which database?',
          description: 'DB',
          oneOf: [
            { const: 'Postgres', title: 'Postgres', description: 'relational' },
            { const: 'SQLite', title: 'SQLite' },
            { const: 'Mongo', title: 'Mongo' }
          ],
          default: 'SQLite'
        },
        q0__other: { type: 'string', title: 'Other (type your own)' },
        q1: {
          type: 'array',
          title: 'Which features?',
          items: {
            anyOf: [
              { const: 'Auth', title: 'Auth' },
              { const: 'Billing', title: 'Billing' },
              { const: 'Search', title: 'Search' }
            ]
          }
        },
        q1__other: { type: 'string', title: 'Other (type your own)' },
        q2__other: { type: 'string', title: 'Other (type your own)' }
      }
    }
  }

  it('asks every question on one card and answers in the form OMP reads', () => {
    const presentation = acpFormElicitationPresentation(ask)
    expect(presentation.body).toMatchObject({
      kind: 'question',
      questions: [
        {
          id: 'q1',
          question: 'Which database?',
          header: 'DB',
          multiSelect: false,
          options: [
            { id: 'o1', label: 'Postgres', description: 'relational' },
            { id: 'o2', label: 'SQLite (Recommended)' },
            { id: 'o3', label: 'Mongo' }
          ],
          freeTextQuestionId: 'q1'
        },
        { id: 'q2', question: 'Which features?', multiSelect: true, freeTextQuestionId: 'q2' },
        { id: 'q3', question: 'Other (type your own)', options: [], freeTextQuestionId: 'q3' }
      ]
    })
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: [], other: 'Cockroach' },
          { questionId: 'q2', optionIds: ['o1', 'o3'], other: 'note' },
          { questionId: 'q3', optionIds: [], other: 'free' }
        ]
      })
    ).toEqual({
      action: 'accept',
      content: {
        q0__other: 'Cockroach',
        q1: ['Auth', 'Search'],
        q1__other: 'note',
        q2__other: 'free'
      }
    })
    expect(presentation.reply(null)).toEqual({ action: 'cancel' })
  })

  it('tells OMP which questions past the fourth were never shown', () => {
    const properties = Object.fromEntries(
      [0, 1, 2, 3, 4].map((n) => [
        `q${n}__other`,
        { type: 'string', title: 'Other (type your own)' }
      ])
    )
    const presentation = acpFormElicitationPresentation({
      ...ask,
      message: 'Answer 5 questions',
      requestedSchema: { type: 'object', properties }
    })
    const answers = [1, 2, 3, 4].map((n) => ({
      questionId: `q${n}`,
      optionIds: [],
      other: `a${n}`
    }))
    expect(presentation.reply({ kind: 'answers', answers })).toEqual({
      action: 'accept',
      content: {
        q0__other: 'a1',
        q1__other: 'a2',
        q2__other: 'a3',
        q3__other: 'a4',
        q4__other: expect.any(String)
      }
    })
  })

  it('answers a confirm form with a boolean', () => {
    const confirm = acpFormElicitationPresentation({
      mode: 'form',
      sessionId: 'session-1',
      message: 'Switch model?',
      requestedSchema: {
        type: 'object',
        properties: { value: { type: 'boolean' } },
        required: ['value']
      }
    })
    expect(
      confirm.reply({ kind: 'answers', answers: [{ questionId: 'q1', optionIds: ['o1'] }] })
    ).toEqual({ action: 'accept', content: { value: true } })
  })
})
