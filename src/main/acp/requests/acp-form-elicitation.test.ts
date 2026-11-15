import { describe, expect, it } from 'vitest'
import { acpFormElicitationPresentation } from './acp-form-elicitation'

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
    ).toThrow(/required features field/)
  })
})
