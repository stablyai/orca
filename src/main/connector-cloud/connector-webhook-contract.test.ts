import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  ConnectorDelivery,
  ConnectorPollResponse
} from '../../shared/connectors/connector-cloud-contract'
import * as mirror from '../../shared/connector-webhook-contract'
import * as routes from '../../shared/connector-webhook-routes'
import { dispatchDelivery } from './connector-deliveries'
import { fakeMachine, fakeSeam } from './fake-connector-seam.test-fixture'

const HOOK = 'wh_7Kx2pQ9mZbV4tL1r'
const CALL = 'call_0123456789abcdefABCD'

// The cloud's webhook-messages.test.ts reads the same corpus, so both readers refuse alike.
const Corpus = z.object({
  base: z.object({ event: z.record(z.string(), z.unknown()) }).catchall(z.unknown()),
  cases: z.array(
    z.object({
      name: z.string(),
      readable: z.boolean(),
      delivery: z.record(z.string(), z.unknown()).optional(),
      event: z.record(z.string(), z.unknown()).optional()
    })
  )
})
const corpus = Corpus.parse(
  JSON.parse(
    readFileSync(
      new URL(
        '../../../cloud/packages/connector-contract/src/test-fixtures/webhook-trigger-deliveries.json',
        import.meta.url
      ),
      'utf8'
    )
  )
)
const withoutNulls = (fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null))

describe('webhook trigger deliveries, as the cloud reads them', () => {
  it.each(corpus.cases.map((entry) => [entry.name, entry] as const))('%s', (_, entry) => {
    const delivery = {
      ...corpus.base,
      ...entry.delivery,
      event: withoutNulls({ ...corpus.base.event, ...entry.event })
    }
    expect(ConnectorDelivery.safeParse(delivery).success).toBe(entry.readable)
  })
})

describe('webhook deliveries on this machine', () => {
  const call = {
    deliveryId: 'trigger:abc',
    expiresAt: 1_800_000_060_000,
    conversation: { source: 'webhook', externalId: 'trigger:abc' },
    kind: 'trigger',
    automationId: 'auto-1',
    triggerId: mirror.webhookRuleId(HOOK),
    botId: 'bot-1',
    event: {
      key: CALL,
      actorId: mirror.webhookActorId(HOOK),
      occurredAt: 1_800_000_000_000,
      webhook: { callId: CALL, epoch: 2, hostGen: 1 }
    }
  }
  const dispatch = (raw: unknown, notices = true) => {
    const ran: ConnectorDelivery[] = []
    const machine = fakeMachine(() => null)
    const dispatched = dispatchDelivery(
      fakeSeam().seam,
      machine.conversationHost(),
      {
        runTrigger: async (delivery) => {
          ran.push(delivery)
          return true
        },
        ...(notices
          ? {
              webhookNotice: async (delivery) => {
                ran.push(delivery)
                return delivery.hookId === HOOK
              }
            }
          : {})
      },
      raw,
      () => 60_000
    )
    return { ran, done: dispatched?.done }
  }

  it("hands a call to its automation with the hook's generations", async () => {
    const { ran, done } = dispatch(call)
    expect(await done).toEqual({ outcome: 'accepted' })
    expect(ran).toMatchObject([{ event: { webhook: { callId: CALL, epoch: 2, hostGen: 1 } } }])
  })

  it("posts a hook's notice, and settles it unsupported where notices aren't handled", async () => {
    const notice = {
      deliveryId: `webhook-notice:${HOOK}:refusal_burst:1`,
      expiresAt: 1_800_000_060_000,
      conversation: { source: 'webhook', externalId: `webhook-notice:${HOOK}:refusal_burst:1` },
      kind: 'webhook_notice',
      hookId: HOOK,
      botId: 'bot-1',
      condition: 'refusal_burst',
      count: 12,
      at: 1_800_000_000_000
    }
    const handled = dispatch(notice)
    expect(await handled.done).toEqual({ outcome: 'accepted' })
    expect(handled.ran).toMatchObject([{ kind: 'webhook_notice', count: 12 }])
    expect(await dispatch(notice, false).done).toEqual({ outcome: 'unsupported' })
  })

  it("reads an older cloud's trigger delivery as before", async () => {
    const { ran, done } = dispatch({
      ...call,
      conversation: { source: 'slack', externalId: 'trigger:abc' },
      triggerId: 't1',
      event: { key: 'T:C:1', actorId: 'U0MEMBER', occurredAt: 1 }
    })
    expect(await done).toEqual({ outcome: 'accepted' })
    expect(ran).toHaveLength(1)
  })

  it.each([
    [
      'call fields it cannot read',
      { ...call, event: { ...call.event, webhook: { callId: CALL } } }
    ],
    ['a thread named for a webhook', { ...call, kind: 'send', text: 'hi' }]
  ])('settles a delivery with %s as unsupported', async (_, raw) => {
    const { ran, done } = dispatch(raw)
    expect(await done).toEqual({ outcome: 'unsupported' })
    expect(ran).toHaveLength(0)
  })

  it("keeps a poll whose unsettled list names a conversation this Orca can't read", () => {
    const kept = { deliveryId: 'd1', conversation: { source: 'slack', externalId: 'T:C:1' } }
    const response = ConnectorPollResponse.parse({
      serverNow: 1,
      holdMs: 0,
      unsettled: [{ deliveryId: 'd0', conversation: { source: 'teams', externalId: 'x' } }, kept],
      deliveries: []
    })
    expect(response.unsettled).toEqual([kept])
  })
})

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
      startAnswers: z.array(ContractCase),
      startConflicts: z.array(ContractCase),
      startSettled: z.array(ContractCase),
      notices: z.array(ContractCase),
      views: z.array(ContractCase),
      callLogs: z.array(ContractCase),
      envelopes: z.array(ContractCase)
    }),
    acknowledgments: z.array(ContractCase)
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL(
          '../../../cloud/packages/connector-contract/src/test-fixtures/webhook-contract.json',
          import.meta.url
        ),
        'utf8'
      )
    )
  )

describe('webhook contract corpus', () => {
  it('pins every mirrored constant', () => {
    expect({
      WEBHOOK_HOOK_ID_PATTERN: mirror.WEBHOOK_HOOK_ID_PATTERN.source,
      WEBHOOK_CALL_ID_PATTERN: mirror.WEBHOOK_CALL_ID_PATTERN.source,
      WEBHOOK_ADAPTERS: mirror.WEBHOOK_ADAPTERS,
      WEBHOOK_CALL_STATES: mirror.WEBHOOK_CALL_STATES,
      WEBHOOK_RUN_CAPS: mirror.WEBHOOK_RUN_CAPS,
      WEBHOOK_NOTICE_CONDITIONS: mirror.WEBHOOK_NOTICE_CONDITIONS,
      WEBHOOK_FILTER_LIMITS: mirror.WEBHOOK_FILTER_LIMITS,
      WEBHOOK_WHERE_OPS: mirror.WEBHOOK_WHERE_OPS
    }).toEqual(contractCorpus.constants)
  })

  it.each(contractCorpus.names)('names $hookId', ({ hookId, ruleId, actorId }) => {
    expect(mirror.webhookRuleId(hookId)).toBe(ruleId)
    expect(mirror.webhookActorId(hookId)).toBe(actorId)
    expect(mirror.hookIdOfRule(ruleId)).toBe(hookId)
    expect(mirror.hookIdOfActor(actorId)).toBe(hookId)
  })

  for (const [pattern, cases] of [
    [mirror.WEBHOOK_HOOK_ID_PATTERN, contractCorpus.patterns.hookIds],
    [mirror.WEBHOOK_CALL_ID_PATTERN, contractCorpus.patterns.callIds]
  ] as const) {
    it.each(cases)('recognizes $name', ({ input, readable }) => {
      expect(pattern.test(z.string().parse(input))).toBe(readable)
    })
  }

  it.each(contractCorpus.ruleBytes)('counts rule bytes: $name', ({ rule, bytes }) => {
    expect(mirror.webhookRuleBytes(rule)).toBe(bytes)
  })

  for (const [label, schema, cases] of [
    ['start answer', mirror.WebhookCallStartAnswer, contractCorpus.messages.startAnswers],
    ['start conflict', mirror.WebhookCallStartConflict, contractCorpus.messages.startConflicts],
    ['settled call', mirror.WebhookCallStartSettled, contractCorpus.messages.startSettled],
    ['notice', ConnectorDelivery, contractCorpus.messages.notices],
    ['hook view', routes.WebhookView, contractCorpus.messages.views],
    ['call log', routes.WebhookCalls, contractCorpus.messages.callLogs],
    ['envelope', routes.WebhookEnvelope, contractCorpus.messages.envelopes]
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
