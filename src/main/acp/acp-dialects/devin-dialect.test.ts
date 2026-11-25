import { describe, expect, it } from 'vitest'
import { DEVIN_ACP_DIALECT } from './devin-dialect'

// Captured from Devin CLI 3000.14.30821's ask_user_question (one single- and one multi-select).
const askUserQuestion = {
  mode: 'form',
  sessionId: 'snowy-plain',
  requestedSchema: {
    type: 'object',
    properties: {
      q0: {
        type: 'string',
        title: 'Color',
        description: 'Which color?',
        oneOf: [
          { const: 'Red', title: 'Red' },
          { const: 'Blue', title: 'Blue' }
        ]
      },
      q1: {
        type: 'array',
        title: 'Fruits',
        description: 'Which fruits?',
        minItems: 1,
        items: {
          anyOf: [
            { const: 'Apple', title: 'Apple' },
            { const: 'Pear', title: 'Pear' }
          ]
        }
      }
    },
    required: ['q0', 'q1']
  },
  message: 'Which color?',
  _meta: { 'cognition.ai/allowOther': true, 'cognition.ai/toolCallId': 'call_ab6414fd766dac48' }
}

describe('Devin ask_user_question', () => {
  it('offers the promised "Other" answer and sends the typed text as the field value', () => {
    const presentation = DEVIN_ACP_DIALECT.request?.('elicitation/create', askUserQuestion)
    const questions =
      presentation?.body.kind === 'question' ? (presentation.body.questions ?? []) : []
    expect(questions.map((question) => question.freeTextQuestionId)).toEqual(['q1', 'q2'])
    expect(
      presentation?.reply({
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: [], other: 'Green' },
          { questionId: 'q2', optionIds: ['o1'], other: 'Mango' }
        ]
      })
    ).toEqual({ action: 'accept', content: { q0: 'Green', q1: ['Apple', 'Mango'] } })
  })

  it('refuses forms that are not ask_user_question, such as /cloud-setup secrets', () => {
    const { _meta, ...unmarkedForm } = askUserQuestion
    const { 'cognition.ai/allowOther': _allowOther, ...noOtherMeta } = _meta
    const noOtherForm = { ...askUserQuestion, _meta: noOtherMeta }
    const cloudSetupForm = {
      ...askUserQuestion,
      _meta: { ..._meta, 'cognition.ai/cloudSetupSecretValues': {} }
    }
    for (const form of [unmarkedForm, noOtherForm, cloudSetupForm]) {
      expect(() => DEVIN_ACP_DIALECT.request?.('elicitation/create', form)).toThrow(
        expect.objectContaining({ code: -32602 })
      )
    }
  })
})
