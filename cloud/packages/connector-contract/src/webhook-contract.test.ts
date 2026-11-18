import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as names from './webhook-names.js'
import * as matcher from './webhook-matcher.js'
import * as messages from './webhook-messages.js'
import * as routes from './webhook-routes.js'
import { WebhookEnvelopeSchema } from './webhook-envelope.js'
import { ConnectorAcksRequestSchema, ConnectorDeliverySchema } from './delivery-messages.js'

const ContractCase = z.object({
  name: z.string(),
  input: z.unknown(),
  readable: z.boolean(),
  output: z.record(z.string(), z.unknown()).optional()
})
const contractCorpus = z
  .object({
    constants: z.record(z.string(), z.unknown()),
    names: z.array(z.object({ hookId: z.string(), ruleId: z.string(), actorId: z.string() })),
    patterns: z.object({ hookIds: z.array(ContractCase), callIds: z.array(ContractCase) }),
    ruleBytes: z.array(
      z.object({
        name: z.string(),
        rule: z.object({
          id: z.string(),
          automationId: z.string(),
          botId: z.string(),
          source: z.literal('webhook'),
          event: z.literal('call'),
          rev: z.number(),
          graceMinutes: z.number(),
          textContains: z.string()
        }),
        bytes: z.number()
      })
    ),
    messages: z.object({
      startRequests: z.array(ContractCase),
      startAnswers: z.array(ContractCase),
      startConflicts: z.array(ContractCase),
      startSettled: z.array(ContractCase),
      notices: z.array(ContractCase),
      views: z.array(ContractCase),
      callLogs: z.array(ContractCase),
      envelopes: z.array(ContractCase)
    }),
    acknowledgments: z.array(ContractCase),
    routes: z.object({
      hookId: z.string(),
      callId: z.string(),
      paths: z.record(z.string(), z.string()),
      operations: z.record(
        z.string(),
        z.object({ method: z.string(), route: z.string(), body: z.unknown().optional() })
      )
    })
  })
  .parse(
    JSON.parse(
      readFileSync(new URL('./test-fixtures/webhook-contract.json', import.meta.url), 'utf8')
    )
  )

describe('webhook contract corpus', () => {
  it('pins every mirrored constant', () => {
    expect({
      WEBHOOK_HOOK_ID_PATTERN: names.WEBHOOK_HOOK_ID_PATTERN.source,
      WEBHOOK_CALL_ID_PATTERN: names.WEBHOOK_CALL_ID_PATTERN.source,
      WEBHOOK_ADAPTERS: names.WEBHOOK_ADAPTERS,
      WEBHOOK_CALL_STATES: names.WEBHOOK_CALL_STATES,
      WEBHOOK_RUN_CAPS: names.WEBHOOK_RUN_CAPS,
      WEBHOOK_NOTICE_CONDITIONS: messages.WEBHOOK_NOTICE_CONDITIONS,
      WEBHOOK_FILTER_LIMITS: matcher.WEBHOOK_FILTER_LIMITS,
      WEBHOOK_WHERE_OPS: matcher.WEBHOOK_WHERE_OPS
    }).toEqual(contractCorpus.constants)
  })

  it('names every route', () => {
    const { hookId, callId, paths } = contractCorpus.routes
    const { WEBHOOK_ROUTES: r } = routes
    expect({
      hooks: r.hooks,
      hook: r.hook(hookId),
      state: r.state(hookId),
      reveal: r.reveal(hookId),
      rotate: r.rotate(hookId),
      secret: r.secret(hookId),
      sample: r.sample(hookId),
      calls: r.calls(hookId),
      envelope: r.envelope(callId),
      start: r.start(callId)
    }).toEqual(paths)
  })

  it("pins every operation's method, route and body", () => {
    const { operations } = contractCorpus.routes
    expect(Object.keys(routes.WEBHOOK_OPERATIONS).sort()).toEqual(Object.keys(operations).sort())
    for (const [name, operation] of Object.entries(routes.WEBHOOK_OPERATIONS)) {
      const pinned = operations[name]
      expect({ name, method: operation.method, route: operation.route }).toEqual({
        name,
        method: pinned?.method,
        route: pinned?.route
      })
      const request = 'request' in operation ? operation.request : undefined
      expect(request === undefined, name).toBe(pinned?.body === undefined)
      expect(request?.safeParse(pinned?.body).success ?? true, name).toBe(true)
    }
  })

  it.each(contractCorpus.names)('names $hookId', ({ hookId, ruleId, actorId }) => {
    expect(names.webhookRuleId(hookId)).toBe(ruleId)
    expect(names.webhookActorId(hookId)).toBe(actorId)
    expect(names.hookIdOfRule(ruleId)).toBe(hookId)
    expect(names.hookIdOfActor(actorId)).toBe(hookId)
  })

  for (const [pattern, cases] of [
    [names.WEBHOOK_HOOK_ID_PATTERN, contractCorpus.patterns.hookIds],
    [names.WEBHOOK_CALL_ID_PATTERN, contractCorpus.patterns.callIds]
  ] as const) {
    it.each(cases)('recognizes $name', ({ input, readable }) => {
      expect(pattern.test(z.string().parse(input))).toBe(readable)
    })
  }

  it.each(contractCorpus.ruleBytes)('counts rule bytes: $name', ({ rule, bytes }) => {
    expect(matcher.webhookRuleBytes(rule)).toBe(bytes)
  })

  for (const [label, schema, cases] of [
    ['start request', routes.WebhookCallStartRequestSchema, contractCorpus.messages.startRequests],
    ['start answer', messages.WebhookCallStartAnswerSchema, contractCorpus.messages.startAnswers],
    [
      'start conflict',
      messages.WebhookCallStartConflictSchema,
      contractCorpus.messages.startConflicts
    ],
    ['settled call', messages.WebhookCallStartSettledSchema, contractCorpus.messages.startSettled],
    ['notice', ConnectorDeliverySchema, contractCorpus.messages.notices],
    ['hook view', routes.WebhookViewSchema, contractCorpus.messages.views],
    ['call log', routes.WebhookCallsSchema, contractCorpus.messages.callLogs],
    ['envelope', WebhookEnvelopeSchema, contractCorpus.messages.envelopes]
  ] as const) {
    describe(label, () => {
      it.each(cases)('$name', ({ input, readable, output }) => {
        const parsed = schema.safeParse(input)
        expect(parsed.success).toBe(readable)
        if (parsed.success) {
          if (output) {
            expect(parsed.data).toMatchObject(output)
          } else {
            expect(parsed.data).toEqual(input)
          }
        }
      })
    })
  }
})

it.each(contractCorpus.acknowledgments)('acknowledges $name', ({ input, readable }) => {
  const parsed = ConnectorAcksRequestSchema.safeParse(input)
  expect(parsed.success).toBe(readable)
  if (parsed.success) {
    expect(parsed.data).toEqual(input)
  }
})
