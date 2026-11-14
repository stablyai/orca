import { describe, expect, it } from 'vitest'
import { acpFormElicitationPresentation } from './acp-form-elicitation'
import forms from '../fixtures/opencode-v2-question-forms.json'

// OpenCode 2.2.5 ACP recordings; only session/tool identities were replaced.
describe('OpenCode question forms', () => {
  it('keeps a required choice separate from custom text and rejects closed empty choices', () => {
    const form = acpFormElicitationPresentation({
      ...forms.single,
      requestedSchema: { ...forms.single.requestedSchema, required: ['q0'] }
    })
    expect(() =>
      form.reply({
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: [], other: 'DuckDB' },
          { questionId: 'q2', optionIds: [], other: 'separate' }
        ]
      })
    ).toThrow('answer every offered question')
    expect(() =>
      acpFormElicitationPresentation({
        ...forms.empty,
        requestedSchema: { properties: { q0: forms.empty.requestedSchema.properties.q0 } }
      })
    ).toThrow('Unsupported ACP elicitation form')
    const confirmation = acpFormElicitationPresentation({
      ...forms.single,
      requestedSchema: {
        properties: {
          ...forms.single.requestedSchema.properties,
          q0: { ...forms.single.requestedSchema.properties.q0, type: 'boolean' }
        }
      }
    })
    expect(
      confirmation.reply({
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: ['o1'] },
          { questionId: 'q2', optionIds: [], other: 'independent note' }
        ]
      })
    ).toEqual({ action: 'accept', content: { q0: true, q0_custom: 'independent note' } })
  })

  it('does not reject offered answers because an unshown field has no choices', () => {
    const form = acpFormElicitationPresentation({
      ...forms.single,
      requestedSchema: {
        properties: {
          q0: forms.single.requestedSchema.properties.q0,
          q1: forms.single.requestedSchema.properties.q0,
          q2: forms.single.requestedSchema.properties.q0,
          q3: forms.single.requestedSchema.properties.q0,
          q4: { type: 'string', oneOf: [] }
        }
      }
    })
    expect(
      form.reply({
        kind: 'answers',
        answers: ['q1', 'q2', 'q3', 'q4'].map((questionId) => ({ questionId, optionIds: ['o1'] }))
      })
    ).toEqual({
      action: 'accept',
      content: { q0: 'SQLite', q1: 'SQLite', q2: 'SQLite', q3: 'SQLite' }
    })
  })
})
