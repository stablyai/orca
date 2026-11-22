import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ConnectorDeliverySchema } from './delivery-messages.js'
import {
  ConnectorEventSchema,
  ConnectorEventsRequestSchema,
  ConnectorPendingPromptSchema
} from './event-messages.js'

// The cases the host and the cloud read too, so both sides parse prompts and answers alike.
const Case = z.object({
  name: z.string(),
  schema: z.enum(['prompt', 'event', 'events', 'delivery']),
  input: z.unknown(),
  parsed: z.unknown().optional(),
  oldReaderRejects: z.boolean().optional()
})
const corpus = z
  .object({ valid: z.array(Case), degrades: z.array(Case), invalid: z.array(Case) })
  .parse(
    JSON.parse(
      readFileSync(new URL('./test-fixtures/owner-informed-contract.json', import.meta.url), 'utf8')
    )
  )

const schemas = {
  prompt: ConnectorPendingPromptSchema,
  event: ConnectorEventSchema,
  events: ConnectorEventsRequestSchema,
  delivery: ConnectorDeliverySchema
} as const

describe('owner-informed contract corpus', () => {
  it.each(corpus.valid.map((entry) => [entry.name, entry] as const))('parses %s', (_, entry) => {
    expect(schemas[entry.schema].parse(entry.input)).toEqual(entry.input)
  })

  it.each(corpus.degrades.map((entry) => [entry.name, entry] as const))(
    'still parses when %s',
    (_, entry) => {
      expect(schemas[entry.schema].parse(entry.input)).toEqual(entry.parsed)
    }
  )

  it.each(corpus.invalid.map((entry) => [entry.name, entry] as const))('refuses %s', (_, entry) => {
    expect(schemas[entry.schema].safeParse(entry.input).success).toBe(false)
  })

})
