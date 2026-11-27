// `bots.composio.events*`: the card that sends a Composio trigger's events to one of the bot's
// webhooks. The bot asks for it; only the owner's click sets it up.
import {
  ComposioEventsByHand,
  ComposioEventsCard,
  ComposioEventsSetUp,
  ComposioEventsStatus
} from '../../../../shared/rpc-contract/bots-composio-params'
import { composioUserOfBot } from '../../../../shared/composio/composio-apps'
import { automationWebhookTrigger } from '../../../../shared/automation-event-triggers'
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { WebhookWhere } from '../../../../shared/connector-webhook-contract'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, InvalidArgumentError } from '../core'
import { composio, instanceOf, setupBot, webhooksOf } from './bots-composio'
import { ownerOnly } from './bots-caller-gates'

// Every bot's events in one Composio project reach the same address; this keeps this bot's own.
const USER_PATH = 'body.metadata.user_id'

export const BOT_COMPOSIO_EVENTS_METHODS = [
  defineMethod({
    name: 'bots.composio.events',
    permission: 'workspace',
    params: ComposioEventsCard,
    handler: async (params, context) => {
      const bot = setupBot(params, context)
      const { bots, setup } = instanceOf(context.runtime)
      const config = parseConfig(params.config)
      const automation = webhooksOf(context.runtime).automationOf(params.hookId)
      if (automation.bot?.botId !== bot.id) {
        throw new InvalidArgumentError(
          'That webhook isn’t one of yours. `orca webhooks list` lists them.'
        )
      }
      const type = await bots.withKey((api) => api.triggerType(params.trigger))
      const added = await keepToBotsOwnEvents(context.runtime, automation, bot.id)
      return setup.eventsCard(
        bot.id,
        params.hookId,
        {
          slug: params.trigger,
          name: type.name,
          ...(config ? { config: JSON.stringify(config) } : {})
        },
        added
      )
    }
  }),
  defineMethod({
    name: 'bots.composio.eventsStatus',
    permission: 'workspace',
    params: ComposioEventsStatus,
    handler: ({ botId, hookId, trigger }, context) => {
      composio(context, botId)
      return instanceOf(context.runtime).events.status(botId, hookId, trigger)
    }
  }),
  defineMethod({
    name: 'bots.composio.setUpEvents',
    permission: 'workspace',
    params: ComposioEventsSetUp,
    handler: async ({ botId, hookId, trigger, config, replace, byHand }, context) => {
      ownerOnly(context, 'Only your owner answers setup cards, in Orca.')
      composio(context, botId)
      const { bots, events, setup } = instanceOf(context.runtime)
      const settings = parseConfig(config) ?? {}
      await (byHand
        ? events.finishByHand(botId, hookId, trigger, settings, byHand)
        : events.setUp(botId, hookId, trigger, settings, replace === true))
      context.runtime.notifyBotsChanged({ kinds: ['settings'] })
      const name = await bots
        .withKey((api) => api.triggerType(trigger))
        .then(
          (type) => type.name,
          () => trigger
        )
      await setup.eventsSetUp(botId, hookId, name)
      return { done: true }
    }
  }),
  defineMethod({
    name: 'bots.composio.eventsByHand',
    permission: 'workspace',
    params: ComposioEventsByHand,
    handler: async ({ botId, hookId }, context) => {
      ownerOnly(context, 'Only your owner answers setup cards, in Orca.')
      composio(context, botId)
      const { events, setup } = instanceOf(context.runtime)
      const ingress = await events.byHand(botId, hookId)
      context.runtime.notifyBotsChanged({ kinds: ['settings'] })
      await setup.eventsByHand(botId, ingress)
      return { hookId: ingress }
    }
  })
]

/**
 * Orca's own filter on the hook: only the bot's Composio user's events start it, whatever the
 * bot's --on said, since every bot's events in the project reach one address. The clause added,
 * or undefined when it was there.
 */
export async function keepToBotsOwnEvents(
  runtime: OrcaRuntimeService,
  automation: Automation,
  botId: string
): Promise<string | undefined> {
  const user = composioUserOfBot(botId)
  const rule = automationWebhookTrigger(automation)
  if (!rule || (rule.where ?? []).some((clause) => sameClause(clause, user))) {
    return undefined
  }
  const clause: WebhookWhere = { path: USER_PATH, op: '=', values: [user] }
  await runtime.updateAutomation(automation.id, {
    on: (automation.on ?? []).map((trigger) =>
      trigger === rule ? { ...rule, where: [...(rule.where ?? []), clause] } : trigger
    )
  })
  return `where="${USER_PATH} = ${user}"`
}

const sameClause = (clause: WebhookWhere, user: string) =>
  clause.path === USER_PATH && clause.op === '=' && clause.values?.[0] === user

/** A trigger's settings, as the bot wrote them: a JSON object, or nothing. */
function parseConfig(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new InvalidArgumentError('--config takes a JSON object.')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidArgumentError('--config takes a JSON object.')
  }
  return Object.fromEntries(Object.entries(value))
}
