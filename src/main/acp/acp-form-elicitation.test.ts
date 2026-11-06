import { describe, expect, it } from 'vitest'
import { acpFormElicitationPresentation } from './acp-form-elicitation'
import { recordedOmpAskForm as ask } from './acp-omp-ask-form.test-fixture'

describe('OMP ask forms', () => {
  it('asks every question on one card and answers in the form OMP reads', () => {
    const presentation = acpFormElicitationPresentation(ask)
    expect(presentation.body).toMatchObject({
      kind: 'question',
      questions: [
        {
          id: 'q1',
          question: 'Answer 3 questions\n\nWhich database?\n\nDB',
          header: 'Which database?',
          multiSelect: false,
          options: [
            { id: 'o1', label: 'Postgres', description: 'relational' },
            { id: 'o2', label: 'SQLite (Recommended)' },
            { id: 'o3', label: 'Mongo' }
          ],
          freeTextQuestionId: 'q1'
        },
        {
          id: 'q2',
          question: 'Answer 3 questions\n\nWhich features?',
          multiSelect: true,
          freeTextQuestionId: 'q2'
        },
        {
          id: 'q3',
          question: 'Answer 3 questions\n\nOther (type your own)',
          options: [],
          freeTextQuestionId: 'q3'
        }
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
})
