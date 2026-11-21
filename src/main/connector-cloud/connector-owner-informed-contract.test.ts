import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ConnectorDelivery,
  type ConnectorEvent
} from '../../shared/connectors/connector-cloud-contract'
import { ConnectorTurnEvents } from './connector-turn-events'
import { ConnectorEventRequests } from './connector-event-requests'

const Case = z.object({ name: z.string(), schema: z.string(), input: z.unknown() })
const corpus = z
  .object({ valid: z.array(Case), invalid: z.array(Case) })
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          '../../../cloud/packages/connector-contract/src/test-fixtures/owner-informed-contract.json',
          import.meta.url
        ),
        'utf8'
      )
    )
  )

describe('reply-answer wire compatibility', () => {
  it.each(corpus.valid.filter((entry) => entry.schema === 'delivery'))('$name', ({ input }) => {
    // Queue ordering belongs to the cloud; host readers intentionally omit seq.
    const { seq: _seq, ...hostFields } = z.record(z.string(), z.unknown()).parse(input)
    expect(ConnectorDelivery.parse(input)).toEqual(hostFields)
  })
  it.each(corpus.invalid.filter((entry) => entry.schema === 'delivery'))(
    'refuses $name',
    ({ input }) => {
      expect(ConnectorDelivery.safeParse(input).success).toBe(false)
    }
  )
})

const EventRequest = z.object({
  v: z.union([z.literal(1), z.literal(2)]),
  helloRev: z.number(),
  seq: z.number(),
  events: z.array(z.custom<ConnectorEvent>())
})

it.each(corpus.valid.filter((entry) => entry.schema === 'events'))(
  'sends canonical event request: $name',
  async ({ input }) => {
    const request = EventRequest.parse(input)
    const dir = mkdtempSync(join(tmpdir(), 'orca-event-contract-'))
    try {
      const events = new ConnectorTurnEvents(dir, 'owner')
      events.useCloudFeatures(
        new Set(request.v === 2 ? ['prompts.audience'] : []),
        request.helloRev
      )
      let sent: unknown
      const requests = new ConnectorEventRequests({
        events,
        watch: () => () => {},
        observe: () => {},
        flush: () => {},
        post: async (body) => {
          sent = body
          return null
        },
        rejected: () => null
      })
      await requests.post(request.events, request.helloRev, request.seq)
      expect(sent).toEqual(input)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
