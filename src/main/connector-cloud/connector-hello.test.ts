import { describe, expect, it } from 'vitest'
import {
  CONNECTOR_CLIENT_LIMITS,
  type ConnectorBot,
  type ConnectorTrigger
} from '../../shared/connectors/connector-cloud-contract'
import {
  WEBHOOK_FILTER_LIMITS,
  webhookRuleId,
  webhookRuleBytes,
  type ConnectorWebhookTrigger
} from '../../shared/connector-webhook-contract'
import { connectorHello } from './connector-hello'
import { fakeMachine } from './fake-connector-seam.test-fixture'

const longest = (unit: string): string =>
  unit.repeat(CONNECTOR_CLIENT_LIMITS.maxDisplayTextLength / unit.length)

// Every bot at its caps, its name in characters JSON escapes to six bytes each: its Linear people at
// their cap and its other people Slack ones, maxBotMembers in all.
function largestBot(index: number): ConnectorBot {
  const {
    maxBotIdLength,
    maxBotMembers,
    maxBotMemberIdLength,
    maxBotWorkspaceMembers,
    maxBotWorkspaceMemberIdLength,
    maxBotHandleLength
  } = CONNECTOR_CLIENT_LIMITS
  return {
    id: String(index).padStart(maxBotIdLength, 'b'),
    name: longest('\u0001'),
    agent: 'claude',
    members: Array.from({ length: maxBotMembers - maxBotWorkspaceMembers }, (_, member) =>
      String(member).padStart(maxBotMemberIdLength, 'U')
    ),
    paused: false,
    handle: 'h'.repeat(maxBotHandleLength),
    sharedAppWorkspaces: [
      {
        source: 'linear',
        workspaceId: 'w'.repeat(maxBotIdLength),
        members: Array.from({ length: maxBotWorkspaceMembers }, (_, member) =>
          String(member).padStart(maxBotWorkspaceMemberIdLength, 'L')
        )
      }
    ]
  }
}

// Every trigger at the caps a bot automation's rule may reach, in plain text.
function largestTrigger(index: number): ConnectorTrigger {
  const id = (prefix: string) => `${prefix}${index}`.padEnd(128, 'x')
  return {
    id: id('t'),
    automationId: id('a'),
    botId: id('b'),
    source: 'github',
    event: 'review_requested',
    in: Array.from({ length: 10 }, (_, place) => id(`c${place}`)),
    textContains: longest('t'),
    subject: longest('s'),
    graceMinutes: 720
  }
}

// A hook's rule cut to exactly its byte cap, in characters JSON escapes or UTF-8 takes four bytes for.
function largestWebhookRule(index: number): ConnectorWebhookTrigger {
  const id = (prefix: string) => `${prefix}${index}`.padEnd(128, 'x')
  const value = '"\\\u{1F600}'.repeat(10)
  const where = Array.from({ length: WEBHOOK_FILTER_LIMITS.maxWhere }, (_, clause) => ({
    path: `body.f${clause}`,
    op: 'in' as const,
    values: Array.from({ length: WEBHOOK_FILTER_LIMITS.maxValues }, () => value)
  }))
  const rule = {
    id: webhookRuleId(`wh_${String(index).padStart(16, '0')}`),
    automationId: id('a'),
    botId: id('b'),
    source: 'webhook' as const,
    event: 'call' as const,
    rev: 1,
    where,
    subjectFrom: 'body.id',
    textContains: 'x',
    graceMinutes: 720
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

describe('connectorHello', () => {
  it('fits every bot and every trigger at their caps', () => {
    const bots = Array.from({ length: CONNECTOR_CLIENT_LIMITS.maxHelloBots }, (_, index) =>
      largestBot(index)
    )
    const triggers = Array.from(
      { length: CONNECTOR_CLIENT_LIMITS.maxHelloTriggers + 1 },
      (_, index) => largestTrigger(index)
    )
    const { body, trimmed } = connectorHello(
      fakeMachine(() => null),
      { bots, paged: false, cut: false, triggers }
    )
    const json = JSON.stringify(body)
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(CONNECTOR_CLIENT_LIMITS.maxRequestBytes)
    expect(trimmed).toBe(true)
    // Past their cap, triggers are left out and reported.
    expect(body).toMatchObject({
      bots,
      triggers: triggers.slice(0, CONNECTOR_CLIENT_LIMITS.maxHelloTriggers)
    })
  })

  it('keeps every webhook rule at its byte cap beside every bot, and says none was cut (G8)', () => {
    const bots = Array.from({ length: CONNECTOR_CLIENT_LIMITS.maxHelloBots }, (_, index) =>
      largestBot(index)
    )
    const triggers = Array.from({ length: CONNECTOR_CLIENT_LIMITS.maxHelloTriggers }, (_, index) =>
      largestWebhookRule(index)
    )
    expect(webhookRuleBytes(triggers[0]!)).toBe(WEBHOOK_FILTER_LIMITS.maxRuleBytes)
    const { body } = connectorHello(
      fakeMachine(() => null),
      { bots, paged: false, cut: false, triggers }
    )
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(
      CONNECTOR_CLIENT_LIMITS.maxRequestBytes
    )
    expect(body).toMatchObject({ bots, triggers, triggersTruncated: false })
    const over = connectorHello(
      fakeMachine(() => null),
      {
        bots: [],
        paged: false,
        cut: false,
        triggers: [...triggers, largestWebhookRule(100)]
      }
    )
    expect(over.body).toMatchObject({ triggers, triggersTruncated: true })
  })

  it('sends every trigger up to the cap when they fit', () => {
    const trigger = { ...largestTrigger(0), textContains: 'deploy', subject: 'acme/web#1' }
    const triggers = Array.from({ length: CONNECTOR_CLIENT_LIMITS.maxHelloTriggers }, () => trigger)
    const { body, trimmed } = connectorHello(
      fakeMachine(() => null),
      { bots: [], paged: false, cut: false, triggers }
    )
    expect(trimmed).toBe(false)
    expect(body).toMatchObject({ triggers })
  })
})
