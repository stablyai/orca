import { describe, expect, it } from 'vitest'
import { ACP_FORM_ELICITATION_METHOD } from '../requests/acp-form-elicitation'
import { DROID_ACP_DIALECT } from './droid-dialect'

// Droid 1.17.2's AskUser form: a required choice per question, whose `other` value points at a text field.
const choices = [
  { const: 'option_0', title: 'Da', description: 'Da.' },
  { const: 'option_1', title: 'Ne', description: 'Ne.' },
  { const: 'other', title: 'Other answer' }
]
const droidQuestion = (n: number, multiSelect = false) => ({
  [`question_${n}`]: {
    title: `Q${n}`,
    description: `Question ${n}?`,
    ...(multiSelect
      ? { type: 'array', items: { anyOf: choices } }
      : { type: 'string', oneOf: choices })
  },
  [`question_${n}_other`]: {
    type: 'string',
    title: `Q${n}: Other answer`,
    description: 'Enter your answer here if you select Other answer.'
  }
})

describe('DROID_ACP_DIALECT AskUser form', () => {
  it('asks a required choice and its other-answer field as one question', () => {
    const presentation = DROID_ACP_DIALECT.request?.(ACP_FORM_ELICITATION_METHOD, {
      mode: 'form',
      message: 'Droid needs your answers to continue.',
      requestedSchema: {
        type: 'object',
        properties: {
          ...droidQuestion(1),
          ...droidQuestion(2),
          ...droidQuestion(3),
          ...droidQuestion(4, true)
        },
        required: ['question_1', 'question_2', 'question_3', 'question_4']
      }
    })

    if (!presentation) {
      throw new Error('Droid did not claim its AskUser form')
    }
    const { body } = presentation
    if (body.kind !== 'question') {
      throw new Error(`Expected a question, got ${body.kind}`)
    }
    expect(
      body.questions?.map((question) => question.options.map((option) => option.label))
    ).toEqual([
      ['Da', 'Ne'],
      ['Da', 'Ne'],
      ['Da', 'Ne'],
      ['Da', 'Ne']
    ])
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: ['o1'] },
          { questionId: 'q2', optionIds: [], other: 'Maybe' },
          { questionId: 'q3', optionIds: ['o2'] },
          { questionId: 'q4', optionIds: ['o1'], other: 'Both' }
        ]
      })
    ).toEqual({
      action: 'accept',
      content: {
        question_1: 'option_0',
        question_2: 'other',
        question_2_other: 'Maybe',
        question_3: 'option_1',
        question_4: ['option_0', 'other'],
        question_4_other: 'Both'
      }
    })
  })
})
