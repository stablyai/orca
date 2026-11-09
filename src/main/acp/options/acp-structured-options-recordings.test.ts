import { expect, it } from 'vitest'
import recording from '../fixtures/antigravity-v1.4.3-options.json'
import {
  NewSessionResponseSchema,
  SessionModelStateSchema
} from '../generated/acp-protocol.generated'
import { AcpStructuredOptions } from './acp-structured-options'

it('projects recorded ACP selector rows separately from legacy session model IDs', () => {
  const session = NewSessionResponseSchema.extend({ models: SessionModelStateSchema }).parse(
    recording.session
  )
  const options = new AcpStructuredOptions()
  options.adoptSession(session, 'new')
  expect(options.read().models.map(({ id }) => id)).toEqual([
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-pro'
  ])
  expect(options.read().models[0]).toEqual({
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    isDefault: false,
    efforts: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' }
    ]
  })
  options.adoptSession({ models: session.models })
  expect(options.read().models[0]).toEqual({
    id: 'gemini-3.8-flash-high',
    label: 'Gemini 3.8 Flash (High)',
    description: 'Gemini 3.8 Flash model with high thinking level',
    isDefault: false,
    efforts: []
  })
})
