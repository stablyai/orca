import { describe, expect, it } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import { webhookRuleId } from '../../shared/connector-webhook-contract'
import { assertAutomationWebhookRule } from './webhook-rule-check'

function hooked(rule: Record<string, unknown>): Automation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only these fields.
  return {
    id: 'auto-1',
    bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
    missedRunGraceMinutes: 720,
    ...EVENT_ONLY_SCHEDULE,
    on: [
      {
        id: webhookRuleId('wh_7Kx2pQ9mZbV4tL1r'),
        source: 'webhook',
        event: 'call',
        rev: 1,
        ...rule
      }
    ]
  } as unknown as Automation
}

describe("a webhook rule's filters and size", () => {
  it('saves a rule within the matcher and the hello share', () => {
    expect(() =>
      assertAutomationWebhookRule(
        hooked({ where: [{ path: 'body.action', op: '=', values: ['opened'] }] })
      )
    ).not.toThrow()
  })

  it("refuses what the matcher can't read, in its words", () => {
    expect(() => assertAutomationWebhookRule(hooked({ pick: ['body.__proto__.x'] }))).toThrow(
      `"body.__proto__.x" isn't a path`
    )
    expect(() => assertAutomationWebhookRule(hooked({ subject: '4512' }))).toThrow(
      'subject= needs subject-from='
    )
  })

  it('refuses a rule over its share of the hello, measured in UTF-8 as listed', () => {
    // Escapes and 4-byte characters count as the hello sends them.
    const value = `"\\😀${'x'.repeat(190)}`
    const where = Array.from({ length: 8 }, (_, index) => ({
      path: `body.f${index}`,
      op: 'in',
      values: [value, value]
    }))
    expect(() => assertAutomationWebhookRule(hooked({ where }))).toThrow(
      /^This hook's filters are too long \(\d+\.\d KB of 2\.5 KB\); remove some values\.$/
    )
  })
})
