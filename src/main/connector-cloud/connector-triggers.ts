// Bot automations' event rules as a hello lists them, and a trigger delivery as the event a run quotes.
import type {
  ConnectorDelivery,
  ConnectorTrigger
} from '../../shared/connectors/connector-cloud-contract'
import type { Automation } from '../../shared/automations/automation-definition'
import type { Bot } from '../../shared/bot-types'
import {
  isWebhookTrigger,
  takesOwnEvents,
  type AutomationConnectorEventTrigger,
  type AutomationWebhookTrigger,
  type AutomationRunEvent
} from '../../shared/automation-event-triggers'
import { isGoogleTrigger } from '../../shared/automation-google-triggers'
import { hookIdOfRule, webhookActorId } from '../../shared/connector-webhook-contract'

type CloudRule = AutomationConnectorEventTrigger | AutomationWebhookTrigger

type TriggerDelivery = Extract<ConnectorDelivery, { kind: 'trigger' }>

// Names are only for showing a rule here; the cloud matches by refs and ids.
function withoutNames(trigger: CloudRule): CloudRule {
  if (isWebhookTrigger(trigger) || !trigger.names) {
    return trigger
  }
  const sent = { ...trigger }
  delete sent.names
  return sent
}

/**
 * Enabled bot automations' rules; a paused one lists none, so nothing is queued for it. Google rules
 * are checked on this host and never sent. Its webhook
 * rule stays only until the cloud confirms the hook's own pause, so the pause, not the hello, stops it.
 */
export function connectorTriggers(
  automations: readonly Pick<
    Automation,
    'id' | 'enabled' | 'bot' | 'on' | 'missedRunGraceMinutes'
  >[],
  pausing: (hookId: string) => boolean = () => false
): ConnectorTrigger[] {
  return automations.flatMap(({ id, enabled, bot, on, missedRunGraceMinutes }) =>
    bot
      ? (on ?? [])
          .filter((trigger): trigger is CloudRule => !isGoogleTrigger(trigger))
          .filter((trigger) => enabled || pausing(hookIdOfRule(trigger.id) ?? ''))
          .map((trigger) => ({
            ...withoutNames(trigger),
            automationId: id,
            botId: bot.botId,
            graceMinutes: missedRunGraceMinutes,
            ...(bot.resultsTo === 'thread' && trigger.source !== 'webhook'
              ? { inThread: true as const }
              : {})
          }))
      : []
  )
}

/** Anyone when the rule names no one; else the people its `from` names, and its owner when it takes
 *  their own events. The owner's own pull request only ever reaches a rule that still takes theirs,
 *  never one from=me came off while it was on its way. */
function fromPeople(
  trigger: AutomationConnectorEventTrigger,
  actorId: string,
  fromOwner: boolean
): boolean {
  if (fromOwner && takesOwnEvents(trigger) && trigger.fromOwner !== true) {
    return false
  }
  if (!trigger.from?.length && !trigger.fromOwner) {
    return true
  }
  return (trigger.from?.includes(actorId) ?? false) || (trigger.fromOwner === true && fromOwner)
}

/**
 * Source and kind come from this Orca's own rule, never from the delivery. Null once the rule is gone,
 * the automation runs as another bot, or the event isn't one the rule's own `from` or onOwnerMessage
 * takes; Who can ask gates only asking the bot, not its triggers. A webhook call is no person's: the
 * cloud checked the caller held the hook's key, so only its own hook may act.
 */
export function triggerRunEvent(
  automations: readonly Pick<Automation, 'id' | 'bot' | 'on'>[],
  bots: readonly Pick<Bot, 'id'>[],
  delivery: Pick<TriggerDelivery, 'automationId' | 'triggerId' | 'botId' | 'event'> &
    Partial<Pick<TriggerDelivery, 'conversation' | 'inThread' | 'owner'>>
): AutomationRunEvent | null {
  // The PR's head is only for telling a bot worker's own pull request apart (own-pr-trigger-guard.ts).
  const { actorId, fromOwner, onOwnerMessage, webhook, pr: _head, ...event } = delivery.event
  const automation = automations.find((entry) => entry.id === delivery.automationId)
  const bot = bots.find((entry) => entry.id === delivery.botId)
  const trigger =
    bot && automation?.bot?.botId === bot.id
      ? automation.on?.find((rule) => rule.id === delivery.triggerId)
      : undefined
  // The cloud never has a Google rule, so it can't deliver one.
  if (!trigger || !bot || isGoogleTrigger(trigger)) {
    return null
  }
  const hookId = hookIdOfRule(trigger.id)
  // A hook's call starts only its own hook's rule; any other rule takes no call fields.
  const allowed =
    trigger.source === 'webhook'
      ? hookId !== null && webhook !== undefined && !fromOwner && actorId === webhookActorId(hookId)
      : webhook === undefined &&
        fromPeople(trigger, actorId, fromOwner === true) &&
        (!trigger.onOwnerMessage || onOwnerMessage === true)
  if (!allowed) {
    return null
  }
  const run = {
    ...event,
    triggerId: trigger.id,
    source: trigger.source,
    event: trigger.event,
    // A hook's actor id names the hook, not a person.
    ...(trigger.source === 'webhook' ? {} : { actorId, ...(fromOwner ? { fromOwner } : {}) })
  }
  // Only a conversation the cloud bound to the event's thread is one a run may answer in.
  const { conversation, owner } = delivery
  if (
    trigger.source === 'webhook' ||
    !delivery.inThread ||
    conversation?.source !== trigger.source
  ) {
    return run
  }
  return {
    ...run,
    conversation: { source: trigger.source, externalId: conversation.externalId },
    ...(owner?.conversation.source === trigger.source
      ? {
          threadOwner: {
            conversation: { source: trigger.source, externalId: owner.conversation.externalId },
            actsFor: owner.actsFor
          }
        }
      : {})
  }
}
