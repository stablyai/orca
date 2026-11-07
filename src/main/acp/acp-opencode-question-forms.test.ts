import { describe, expect, it } from 'vitest'
import { acpFormElicitationPresentation } from './acp-form-elicitation'
import forms from './fixtures/opencode-v2-question-forms.json'

// OpenCode 2.2.5 ACP recordings; only session/tool identities were replaced.
describe('OpenCode question forms', () => {
  it('keeps the full single question for current and legacy clients and returns original values', () => {
    const form = acpFormElicitationPresentation(forms.single)
    expect(form.body).toMatchObject({
      question: 'Questions\n\nStorage\n\nWhich storage?',
      questions: [
        {
          question: 'Questions\n\nStorage\n\nWhich storage?',
          header: 'Storage',
          freeTextQuestionId: 'q1'
        }
      ]
    })
    expect(form.reply({ kind: 'option', optionId: 'o2' })).toEqual({
      action: 'accept',
      content: { q0: 'Postgres' }
    })
    expect(
      form.reply({
        kind: 'answers',
        answers: [{ questionId: 'q1', optionIds: [], other: 'DuckDB' }]
      })
    ).toEqual({ action: 'accept', content: { q0_custom: 'DuckDB' } })
    expect(form.reply(null)).toEqual({ action: 'cancel' })
  })

  it.each(['single', 'multi'])(
    'keeps an empty %s choice answerable under its custom key',
    (kind) => {
      const form = acpFormElicitationPresentation({
        ...forms.empty,
        requestedSchema: {
          ...forms.empty.requestedSchema,
          properties: {
            ...forms.empty.requestedSchema.properties,
            q0:
              kind === 'single'
                ? forms.empty.requestedSchema.properties.q0
                : { type: 'array', title: 'Name', items: { anyOf: [] } }
          }
        }
      })
      expect(form.body).toMatchObject({
        questions: [{ options: [], freeTextQuestionId: 'q1' }]
      })
      expect(
        form.reply({
          kind: 'answers',
          answers: [{ questionId: 'q1', optionIds: [], other: 'Atlas' }]
        })
      ).toEqual({
        action: 'accept',
        content: kind === 'single' ? { q0_custom: 'Atlas' } : { q0: [], q0_custom: 'Atlas' }
      })
      expect(() =>
        form.reply({
          kind: 'answers',
          answers: [{ questionId: 'q1', optionIds: [], other: '   ' }]
        })
      ).toThrow('answer every offered question')
    }
  )

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

  it('tells the agent which overflow question was not shown using its original custom key', () => {
    const form = acpFormElicitationPresentation({
      ...forms.single,
      requestedSchema: {
        properties: Object.fromEntries(
          [0, 1, 2, 3, 4].flatMap((index) => [
            [`q${index}`, forms.single.requestedSchema.properties.q0],
            [`q${index}_custom`, forms.single.requestedSchema.properties.q0_custom]
          ])
        )
      }
    })
    expect(
      form.reply({
        kind: 'answers',
        answers: ['q1', 'q2', 'q3', 'q4'].map((questionId) => ({ questionId, optionIds: ['o1'] }))
      })
    ).toEqual({
      action: 'accept',
      content: {
        q0: 'SQLite',
        q1: 'SQLite',
        q2: 'SQLite',
        q3: 'SQLite',
        q4_custom: 'Not shown to the user: Orca shows at most 4 questions at once. Ask again.'
      }
    })
  })

  it('shows and returns the web-search provider decision', () => {
    const form = acpFormElicitationPresentation(forms.websearch)
    expect(form.body).toMatchObject({
      question: 'Web Search\n\nAllow OpenCode to search the web for up-to-date information?'
    })
    expect(form.reply({ kind: 'option', optionId: 'o3' })).toEqual({
      action: 'accept',
      content: { choice: 'disable' }
    })
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
