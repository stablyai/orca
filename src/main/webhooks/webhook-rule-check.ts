// A webhook rule's filters and size, checked where the one matcher can be imported.
import {
  webhookFiltersProblem,
  webhookRuleBytes
} from '../../../cloud/packages/connector-contract/src/webhook-matcher'
import {
  assertAutomationEventTriggers,
  automationWebhookTrigger
} from '../../shared/automation-event-triggers'
import type { Automation } from '../../shared/automations/automation-definition'
import { WEBHOOK_FILTER_LIMITS } from '../../shared/connector-webhook-contract'

const kilobytes = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`

/** An update replaces the whole trigger set, so an empty one removes it before the rules are checked. */
export function settleAutomationTriggers(automation: Automation): void {
  if (!automation.on?.length) {
    delete automation.on
  }
  assertAutomationTriggers(automation)
}

/** Every event rule, the webhook's against the matcher too; throws in words a bot can act on. */
export function assertAutomationTriggers(automation: Automation): void {
  assertAutomationEventTriggers(automation)
  assertAutomationWebhookRule(automation)
}

/** Throws, in words a bot can act on, when the automation's webhook rule can't be saved. */
export function assertAutomationWebhookRule(automation: Automation): void {
  const rule = automationWebhookTrigger(automation)
  if (!rule) {
    return
  }
  const problem = webhookFiltersProblem(rule)
  if (problem) {
    throw new Error(problem)
  }
  // Measured as the hello lists it (connector-triggers.ts), so every rule fits its share of the hello.
  const bytes = webhookRuleBytes({
    ...rule,
    automationId: automation.id,
    botId: automation.bot?.botId,
    graceMinutes: automation.missedRunGraceMinutes
  })
  if (bytes > WEBHOOK_FILTER_LIMITS.maxRuleBytes) {
    throw new Error(
      `This hook's filters are too long (${kilobytes(bytes)} of ${kilobytes(WEBHOOK_FILTER_LIMITS.maxRuleBytes)}); remove some values.`
    )
  }
}
