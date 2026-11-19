import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import { ConnectorDeliverySchema } from './delivery-messages.js'
import { ConnectorHelloRequestSchema, helloShowsHookRuleGone } from './hello-messages.js'
import type { ConnectorTrigger } from './trigger-messages.js'
import { WEBHOOK_FILTER_LIMITS, webhookRuleBytes } from './webhook-matcher.js'
import { ConnectorWebhookTriggerSchema, type ConnectorWebhookTrigger } from './webhook-messages.js'
import { redactWebhookKeys, webhookPath, webhookRuleId } from './webhook-names.js'

const HOOK = 'wh_7Kx2pQ9mZbV4tL1r'
const KEY = `orcawh_${'k'.repeat(43)}`

const webhookRule: ConnectorWebhookTrigger = {
  id: webhookRuleId(HOOK),
  automationId: 'auto-1',
  botId: 'bot-1',
  source: 'webhook',
  event: 'call',
  rev: 1,
  where: [{ path: 'body.data.event.level', op: 'in', values: ['error', 'fatal'] }],
  pick: ['body.data.event.title'],
  subjectFrom: 'body.data.event.issue_id',
  graceMinutes: 720
}
const slackRule: ConnectorTrigger = {
  id: 't1',
  automationId: 'auto-1',
  botId: 'bot-1',
  source: 'slack',
  event: 'mentioned',
  graceMinutes: 720
}

const hello = {
  v: 1,
  contract: 1,
  orcaVersion: '1.4.230',
  platform: 'darwin',
  runtime: 'desktop',
  hostName: 'mac',
  promptKinds: [],
  features: ['trigger', 'webhook'],
  sources: ['slack']
}

// Every value in characters JSON escapes or UTF-8 takes four bytes for, cut to exactly the byte cap.
function largestWebhookRule(index: number): ConnectorWebhookTrigger {
  const id = (prefix: string) => `${prefix}${index}`.padEnd(CONNECTOR_LIMITS.maxBotIdLength, 'x')
  const value = '"\\\u{1F600}'.repeat(10)
  const where = Array.from({ length: WEBHOOK_FILTER_LIMITS.maxWhere }, (_, clause) => ({
    path: `body.f${clause}`,
    op: 'in' as const,
    values: Array.from({ length: WEBHOOK_FILTER_LIMITS.maxValues }, () => value)
  }))
  const rule = {
    ...webhookRule,
    id: webhookRuleId(`wh_${String(index).padStart(16, '0')}`),
    automationId: id('a'),
    botId: id('b'),
    where,
    textContains: 'x'
  }
  while (webhookRuleBytes(rule) > WEBHOOK_FILTER_LIMITS.maxRuleBytes) {
    const last = where.at(-1)
    if (last && last.values.length > 1) {
      last.values.pop()
    } else {
      where.pop()
    }
  }
  rule.textContains += 'x'.repeat(WEBHOOK_FILTER_LIMITS.maxRuleBytes - webhookRuleBytes(rule))
  return rule
}

describe('webhook rules', () => {
  it.each([
    [
      'a clause field this cloud does not know',
      { ...webhookRule, where: [{ path: 'body.a', op: 'exists', not: true }] }
    ],
    ['an id that names no hook', { ...webhookRule, id: 'on-0123456789abcdef' }],
    ['a forbidden path', { ...webhookRule, pick: ['body.__proto__'] }],
    ['subject= without subject-from=', { ...webhookRule, subjectFrom: undefined, subject: '42' }],
    ['an unknown op', { ...webhookRule, where: [{ path: 'body.a', op: '>' }] }]
  ])('refuses %s', (_, rule) => {
    expect(ConnectorWebhookTriggerSchema.safeParse(rule).success).toBe(false)
  })

  it('holds a rule to its byte cap, escapes and 4-byte characters counted', () => {
    const largest = largestWebhookRule(0)
    expect(webhookRuleBytes(largest)).toBe(WEBHOOK_FILTER_LIMITS.maxRuleBytes)
    expect(ConnectorWebhookTriggerSchema.parse(largest)).toEqual(largest)
    const over = { ...largest, textContains: `${largest.textContains}x` }
    expect(ConnectorWebhookTriggerSchema.safeParse(over).error?.issues[0]?.message).toBe(
      '2561 bytes, over 2560'
    )
  })
})

describe('hello triggers with hooks', () => {
  it('keeps one webhook rule per automation, and every other rule', () => {
    const second = { ...webhookRule, id: webhookRuleId('wh_000000000000000B') }
    const other = {
      ...webhookRule,
      id: webhookRuleId('wh_000000000000000C'),
      automationId: 'auto-2'
    }
    const parsed = ConnectorHelloRequestSchema.parse({
      ...hello,
      triggers: [webhookRule, slackRule, second, other]
    })
    expect(parsed.triggers).toEqual([webhookRule, slackRule, other])
  })

  it('drops a webhook rule it cannot read in full, never its filters alone', () => {
    const parsed = ConnectorHelloRequestSchema.parse({
      ...hello,
      triggers: [{ ...webhookRule, where: [], newFilter: 'x' }, slackRule]
    })
    expect(parsed.triggers).toEqual([slackRule])
    expect(parsed.unreadHookIds).toEqual([HOOK])
  })

  const at = (hookId: string, automationId: string) => ({
    ...webhookRule,
    id: webhookRuleId(hookId),
    automationId
  })
  const H1 = 'wh_000000000000000A'
  const H2 = 'wh_000000000000000B'
  it.each([
    ['an unreadable copy before it', [{ ...webhookRule, newFilter: 'x' }, webhookRule], [], [HOOK]],
    ['one hook under two automations', [at(H1, 'a'), at(H1, 'b')], [], [H1]],
    [
      'a second hook of an automation, listed first under another',
      [at(H2, 'b'), at(H1, 'a'), at(H2, 'a')],
      [at(H1, 'a')],
      [H2]
    ]
  ])("never runs a hook's rule beside %s", (_, triggers, kept, unread) => {
    const parsed = ConnectorHelloRequestSchema.parse({ ...hello, triggers })
    expect(parsed.triggers).toEqual(kept)
    expect(parsed.unreadHookIds).toEqual(unread)
  })

  it("shows a hook's rule gone only from a complete listing by a machine that lists webhook", () => {
    const other = 'wh_000000000000000C'
    const goneFrom = (fields: object) =>
      [HOOK, other].filter((hookId) =>
        helloShowsHookRuleGone(ConnectorHelloRequestSchema.parse({ ...hello, ...fields }), hookId)
      )
    const unreadable = { ...webhookRule, newFilter: 'only-safe' }
    const oversized = largestWebhookRule(0)
    const over = {
      ...oversized,
      id: webhookRuleId(HOOK),
      textContains: `${oversized.textContains}x`
    }
    const secondOfItsAutomation = { ...webhookRule, id: webhookRuleId(other) }
    expect(goneFrom({ triggers: [webhookRule], triggersTruncated: false })).toEqual([other])
    expect(goneFrom({ triggers: [], triggersTruncated: false })).toEqual([HOOK, other])
    expect(goneFrom({ triggers: [unreadable], triggersTruncated: false })).toEqual([other])
    expect(goneFrom({ triggers: [over], triggersTruncated: false })).toEqual([other])
    expect(
      goneFrom({
        triggers: [webhookRule, secondOfItsAutomation],
        triggersTruncated: false
      })
    ).toEqual([])
    expect(goneFrom({ triggers: [], triggersTruncated: true })).toEqual([])
    expect(goneFrom({ triggers: [] })).toEqual([])
    // As a stored hello reads back: its rules live in their own rows.
    expect(goneFrom({ triggersTruncated: false })).toEqual([])
    expect(
      goneFrom({
        features: ['trigger'],
        triggers: [],
        triggersTruncated: false
      })
    ).toEqual([])
  })

  it('fits every bot and every webhook rule at their caps in one request (G8)', () => {
    const id = (prefix: string) => prefix.padEnd(CONNECTOR_LIMITS.maxBotIdLength, 'x')
    const bot = {
      id: id('b'),
      name: '"'.repeat(CONNECTOR_LIMITS.maxDisplayTextLength),
      agent: 'claude',
      members: Array.from({ length: CONNECTOR_LIMITS.maxBotMembers }, () => 'U'.repeat(32)),
      paused: false
    }
    const triggers = Array.from({ length: CONNECTOR_LIMITS.maxHelloTriggers }, (_, index) =>
      largestWebhookRule(index)
    )
    const body = JSON.stringify({
      ...hello,
      bots: Array.from({ length: CONNECTOR_LIMITS.maxHelloBots }, () => bot),
      triggers,
      triggersTruncated: false
    })
    const parsed = ConnectorHelloRequestSchema.parse(JSON.parse(body))
    expect(parsed.triggers).toEqual(triggers)
    expect(parsed.triggersTruncated).toBe(false)
    expect(Buffer.byteLength(body)).toBeLessThan(CONNECTOR_LIMITS.maxRequestBytes)
  })
})

// The desktop's connector-webhook-contract.test.ts reads the same corpus.
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
      new URL('./test-fixtures/webhook-trigger-deliveries.json', import.meta.url),
      'utf8'
    )
  )
)
const withoutNulls = (fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null))

describe('webhook trigger deliveries', () => {
  it.each(corpus.cases.map((entry) => [entry.name, entry] as const))('%s', (_, entry) => {
    const delivery = {
      ...corpus.base,
      ...entry.delivery,
      event: withoutNulls({ ...corpus.base.event, ...entry.event })
    }
    const parsed = ConnectorDeliverySchema.safeParse(delivery)
    expect(parsed.success).toBe(entry.readable)
    if (parsed.success) {
      expect(parsed.data).toMatchObject({ kind: 'trigger', event: delivery.event })
    }
  })
})

describe('webhook key redaction', () => {
  it.each([
    [`curl -H "Authorization: Bearer ${KEY}"`, 'curl -H "Authorization: Bearer [key]"'],
    [`https://orca.dev${webhookPath(HOOK, KEY)}?x=1`, `https://orca.dev/hooks/${HOOK}/[key]?x=1`],
    [`https://orca.dev/hooks/${HOOK}/orcawh%5Fabc)`, `https://orca.dev/hooks/${HOOK}/[key])`],
    [
      `{"url":"https:\\/\\/orca.dev\\/hooks\\/${HOOK}\\/${KEY}"}`,
      `{"url":"https:\\/\\/orca.dev\\/hooks\\/${HOOK}\\/[key]"}`
    ],
    [`POST https://orca.dev/hooks/${HOOK}`, `POST https://orca.dev/hooks/${HOOK}`]
  ])('redacts keys from %j', (text, redacted) => {
    expect(redactWebhookKeys(text, '[key]')).toBe(redacted)
  })
})
