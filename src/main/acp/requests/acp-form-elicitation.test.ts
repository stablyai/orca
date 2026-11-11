import { describe, expect, it } from 'vitest'
import { acpFormElicitationPresentation } from './acp-form-elicitation'
import { recordedOmpAskForm as ask } from './testing/acp-omp-ask-form.test-fixture'

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

function singleField(property: Record<string, unknown>, required = true) {
  return {
    mode: 'form',
    message: 'Fill in',
    requestedSchema: {
      type: 'object',
      properties: { value: property },
      ...(required ? { required: ['value'] } : {})
    }
  }
}

function questionBody(presentation: ReturnType<typeof acpFormElicitationPresentation>) {
  return presentation.body as unknown as {
    questions: { freeTextInput?: Record<string, unknown> }[]
  }
}

function replyWith(params: unknown, other: string) {
  const presentation = acpFormElicitationPresentation(params)
  return presentation.reply({
    kind: 'answers',
    answers: [{ questionId: 'q1', optionIds: [], other }]
  })
}

describe('ACP numeric elicitation fields', () => {
  it('accepts a decimal for a number field', () => {
    expect(replyWith(singleField({ type: 'number' }), '0.5')).toEqual({
      action: 'accept',
      content: { value: 0.5 }
    })
  })

  it('accepts an integer for an integer field', () => {
    expect(replyWith(singleField({ type: 'integer' }), '42')).toEqual({
      action: 'accept',
      content: { value: 42 }
    })
  })

  it('enforces minimum and maximum', () => {
    const params = singleField({ type: 'number', minimum: 0, maximum: 10 })
    expect(replyWith(params, '10')).toEqual({ action: 'accept', content: { value: 10 } })
    expect(() => replyWith(params, '11')).toThrow(
      'Question answer must be a valid number at least 0 at most 10'
    )
    expect(() => replyWith(params, '-1')).toThrow(
      'Question answer must be a valid number at least 0 at most 10'
    )
  })

  it.each(['abc', '1.5', '0x1F', 'Infinity', '1 2'])('rejects %s as an answer', (other) => {
    const params = singleField({ type: other === '1.5' ? 'integer' : 'number' })
    expect(() => replyWith(params, other)).toThrow(
      other === '1.5' ? 'valid integer' : 'valid number'
    )
  })

  it('omits a blank optional number', () => {
    const params = singleField({ type: 'number' }, false)
    const presentation = acpFormElicitationPresentation(params)
    expect(questionBody(presentation).questions[0]!.freeTextInput).toMatchObject({
      allowEmpty: true
    })
    expect(replyWith(params, '')).toEqual({ action: 'accept', content: {} })
  })

  it('rejects a blank required number', () => {
    const params = singleField({ type: 'number' })
    const presentation = acpFormElicitationPresentation(params)
    expect(questionBody(presentation).questions[0]!.freeTextInput).toMatchObject({
      allowEmpty: false
    })
  })

  it('uses a numeric default as the initial value', () => {
    const presentation = acpFormElicitationPresentation(singleField({ type: 'number', default: 3 }))
    expect(questionBody(presentation).questions[0]!.freeTextInput).toMatchObject({
      initialValue: '3'
    })
  })

  it('keeps string answers as text', () => {
    expect(replyWith(singleField({ type: 'string' }), '007')).toEqual({
      action: 'accept',
      content: { value: '007' }
    })
  })
})
