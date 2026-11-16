import { describe, expect, it } from 'vitest'
import { ANTIGRAVITY_ACP_DIALECT } from './antigravity-dialect'

// Shape captured from the server's ask_question when the client advertises form elicitation.
const question = { type: 'string', title: 'Pick a color', oneOf: [{ const: '1', title: 'Red' }] }
const writeIn = { type: 'string', title: 'Other', description: 'Optional free-form answer' }
const form = (message: string, properties: Record<string, unknown>) => ({
  sessionId: 's1',
  toolCallId: 'call_1',
  mode: 'form',
  message,
  requestedSchema: { type: 'object', properties }
})
const present = (params: unknown) => ANTIGRAVITY_ACP_DIALECT.request?.('elicitation/create', params)

describe('Antigravity ask_question forms', () => {
  it('shows the question with a write-in field and returns typed text as the answer', () => {
    const presentation = present(
      form('The agent has a question.', { q1: question, q1_other: writeIn })
    )
    expect(presentation?.body).toMatchObject({
      kind: 'question',
      question: 'Pick a color',
      options: [{ id: 'o1', label: 'Red' }],
      freeTextQuestionId: 'q1'
    })
    expect(
      presentation?.reply({
        kind: 'answers',
        answers: [{ questionId: 'q1', optionIds: [], other: 'Green please' }]
      })
    ).toEqual({ action: 'accept', content: { q1_other: 'Green please' } })
    expect(presentation?.reply({ kind: 'option', optionId: 'o1' })).toEqual({
      action: 'accept',
      content: { q1: '1' }
    })
    expect(presentation?.reply(null)).toEqual({ action: 'cancel' })
  })

  it('keeps the question as the heading of a lone multi-select card', () => {
    const toppings = { type: 'array', title: 'Pick toppings', items: { anyOf: question.oneOf } }
    expect(present(form('The agent has a question.', { q1: toppings }))?.body).toMatchObject({
      question: 'Pick toppings'
    })
  })

  it('leaves other forms, such as forwarded MCP requests, to the shared presentation', () => {
    expect(present(form('Choose a deployment target', { q1: question }))).toBeUndefined()
  })
})
