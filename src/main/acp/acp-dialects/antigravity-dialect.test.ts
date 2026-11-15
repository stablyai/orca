import { expect, it } from 'vitest'
import fixture from '../fixtures/antigravity-v1.4.3-options.json'
import {
  NewSessionResponseSchema,
  SessionConfigOptionSchema
} from '../generated/acp-protocol.generated'
import { acpSelectChoices } from '../options/acp-select-choices'
import { AcpStructuredOptions } from '../options/acp-structured-options'
import { ANTIGRAVITY_ACP_DIALECT } from './antigravity-dialect'

it("reads other model families' efforts from the variants the session advertises", () => {
  const options = new AcpStructuredOptions(ANTIGRAVITY_ACP_DIALECT)
  const efforts = () =>
    Object.fromEntries(
      options
        .read()
        .models.map((model) => [
          model.id,
          model.effortsKnown === false
            ? 'unknown'
            : model.efforts.map(({ value, label }) => `${value}:${label}`)
        ])
    )
  const flash = ['low:Low', 'medium:Medium', 'high:High']
  options.adoptSession(NewSessionResponseSchema.parse(fixture.session), 'new')
  expect(efforts()).toEqual({
    'gemini-3.8-flash': flash,
    'gemini-3.7-flash': flash,
    'gemini-3.6-flash': flash,
    'gemini-3.5-flash': flash,
    'gemini-3.1-pro': ['low:Low', 'high:High']
  })
  // The running model's live menu outranks its family's variants, even when it withdraws a level.
  options.adoptConfigOptions(
    SessionConfigOptionSchema.array()
      .parse(fixture.pro.configOptions)
      .map((option) =>
        option.type === 'select' && option.category === 'thought_level'
          ? {
              ...option,
              currentValue: 'high',
              options: acpSelectChoices(option).filter(({ value }) => value === 'high')
            }
          : option
      )
  )
  expect(efforts()['gemini-3.1-pro']).toEqual(['high:High'])
  expect(efforts()['gemini-3.8-flash']).toEqual(flash)
})
