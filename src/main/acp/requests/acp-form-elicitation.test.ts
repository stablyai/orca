import { describe, expect, it } from 'vitest'
import { acpFormElicitationPresentation } from './acp-form-elicitation'

const options = [
  { const: 'option_0', title: 'Blue' },
  { const: 'option_1', title: 'Green' }
]
const otherOption = { const: 'other', title: 'Other answer' }

// Droid 1.17.2 AskUser: every question is required, lists an "other" choice and has a text companion.
function droidForm() {
  const choices = [...options, otherOption]
  const properties: Record<string, unknown> = {}
  for (const index of [1, 2, 3, 4]) {
    properties[`question_${index}`] =
      index === 2
        ? { type: 'array', title: `Topic ${index}`, items: { anyOf: choices }, minItems: 1 }
        : { type: 'string', title: `Topic ${index}`, oneOf: choices }
    properties[`question_${index}_other`] = {
      type: 'string',
      title: `Topic ${index}: Other answer`,
      description: 'Enter your answer here if you select Other answer.'
    }
  }
  return {
    mode: 'form',
    message: 'Droid needs your answers to continue.',
    requestedSchema: {
      type: 'object',
      properties,
      required: ['question_1', 'question_2', 'question_3', 'question_4']
    }
  }
}

describe('acpFormElicitationPresentation', () => {
  it('shows each Droid question on one card and writes typed text as its "other" choice', () => {
    const presentation = acpFormElicitationPresentation(droidForm())
    const questions =
      presentation.body.kind === 'question' ? (presentation.body.questions ?? []) : []
    expect(questions.map((question) => question.header)).toEqual([
      'Topic 1',
      'Topic 2',
      'Topic 3',
      'Topic 4'
    ])
    for (const question of questions) {
      expect(question.options.map((option) => option.label)).toEqual(['Blue', 'Green'])
      expect(question.freeTextQuestionId).toBe(question.id)
    }
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: ['o1'] },
          { questionId: 'q2', optionIds: ['o2'], other: 'Teal' },
          { questionId: 'q3', optionIds: [], other: 'Navy' },
          { questionId: 'q4', optionIds: ['o2'] }
        ]
      })
    ).toEqual({
      action: 'accept',
      content: {
        question_1: 'option_0',
        question_2: ['option_1', 'other'],
        question_2_other: 'Teal',
        question_3: 'other',
        question_3_other: 'Navy',
        question_4: 'option_1'
      }
    })
  })
})

function form(required: string[]) {
  return acpFormElicitationPresentation({
    mode: 'form',
    message: 'Configure the deploy',
    requestedSchema: {
      properties: {
        region: { type: 'string', title: 'Region', enum: ['us', 'eu'] },
        features: { type: 'array', title: 'Features', items: { enum: ['auth', 'billing'] } }
      },
      required
    }
  })
}

describe('ACP form elicitation replies', () => {
  it('lets only optional fields be skipped', () => {
    const { body } = form(['features'])
    expect(body.kind === 'question' && body.questions?.map((q) => q.skippable)).toEqual([
      true,
      undefined
    ])
  })

  it('leaves a skipped optional field out of the form content', () => {
    expect(
      form([]).reply({
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: ['o2'] },
          { questionId: 'q2', optionIds: [] }
        ]
      })
    ).toEqual({ action: 'accept', content: { region: 'eu' } })
  })

  it('refuses a reply that skips a required field', () => {
    expect(() =>
      form(['features']).reply({
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: ['o2'] },
          { questionId: 'q2', optionIds: [] }
        ]
      })
    ).toThrow(/does not match/)
  })
})
