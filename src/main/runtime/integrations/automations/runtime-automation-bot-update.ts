// The bot part of an update to a bot's automation: its agent and folder follow the bot, and its
// rules, places and chosen chat are looked up as on create.
import type {
  Automation,
  AutomationBotTarget,
  AutomationUpdateInput
} from '../../../../shared/automations/automation-definition'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { botAutomationSetup } from '../../../../shared/bots/bot-agent-setup'
import { withPatchPlaceRefs } from '../../../automations/bot-automation-place-refs'
import {
  assertCloudTakesTriggers,
  withTriggerPeople
} from '../../../automations/bot-trigger-people'
import type { RuntimeAutomationController } from './runtime-automation-controller'
import type {
  RuntimeAutomationCreateInput,
  RuntimeAutomationUpdateInput
} from './runtime-automation-run-context'
import type { Bot } from '../../../../shared/bot-types'
import { routeToOriginThread } from '../../../automations/bot-automation-origin-thread'
import {
  assertBotHearsEventTriggers,
  assertNoBotOwnedSettings,
  botAutomationAgent,
  botAutomationTarget,
  requireAutomationBot,
  withCheckedBotChat
} from './runtime-automation-target'

type BotAutomationLookups = Pick<
  RuntimeAutomationController,
  'webhooks' | 'triggerPeople' | 'cloudTriggers' | 'placeRefs' | 'botChat'
>

/** The rules and bot target a new automation is saved with, looked up for its bot. */
export async function botAutomationCreateRules(
  lookups: BotAutomationLookups,
  bot: Bot | null,
  input: RuntimeAutomationCreateInput
) {
  // Only a bot automation can take rules its owner's own pull requests start.
  assertCloudTakesTriggers(
    bot ? lookups.cloudTriggers() : { own: true, github2: true, workflows: true, ciFinished: true },
    input.on
  )
  const rules = bot ? await withTriggerPeople(lookups.triggerPeople(bot), input.on) : input.on
  const inChat = await withCheckedBotChat(input.bot, bot, lookups.botChat)
  const placed = bot
    ? await withPatchPlaceRefs(lookups.placeRefs(), bot.id, { on: rules, bot: inChat })
    : {}
  const on = placed.on ?? rules
  return { on, bot: await inOriginThread(lookups, bot, placed.bot ?? inChat, Boolean(on?.length)) }
}

/** A target made answering a thread, routed to answer there; its places must already be refs. */
async function inOriginThread(
  lookups: Pick<BotAutomationLookups, 'botChat'>,
  bot: Bot | null | undefined,
  target: AutomationBotTarget | undefined,
  hasEvents: boolean
): Promise<AutomationBotTarget | undefined> {
  const thread = target?.originThread
  if (!target || !thread || !bot || hasEvents) {
    return target
  }
  // Its title, for the chat it then continues; a chat that is gone fails at its run as on main.
  const originChat = await lookups.botChat(bot, thread.sessionId)
  return routeToOriginThread(target, { hasEvents, originChat })
}

export async function patchBotAutomationUpdate(
  lookups: BotAutomationLookups,
  store: RuntimeStore,
  current: Automation & { bot: AutomationBotTarget },
  updates: RuntimeAutomationUpdateInput,
  patch: AutomationUpdateInput
): Promise<void> {
  // A deleted bot still lets its automation be paused or renamed.
  const bot = updates.bot
    ? requireAutomationBot(store, updates.bot)
    : store.getBots?.().find((entry) => entry.id === current.bot.botId)
  // A new target decides the agent and is refused with a setup in a chat; any other edit, such as
  // pausing it, keeps the saved one as it is.
  const agent = !bot
    ? current.agentId
    : patch.bot
      ? botAutomationAgent(patch.bot, bot)
      : botAutomationSetup(current.bot, bot).agent
  assertNoBotOwnedSettings(updates, agent)
  patch.bot &&= withOriginThread(
    await withCheckedBotChat(patch.bot, bot, lookups.botChat, current.bot),
    current.bot
  )
  if (bot) {
    assertBotHearsEventTriggers(lookups.webhooks.hearing(bot), updates.on)
    patch.agentId = agent
    patch.workspaceId = botAutomationTarget(bot).workspaceId
    if (patch.on) {
      assertCloudTakesTriggers(lookups.cloudTriggers(), patch.on, current.on)
      patch.on = await withTriggerPeople(lookups.triggerPeople(bot), patch.on, current.on)
    }
  }
  Object.assign(
    patch,
    await withPatchPlaceRefs(lookups.placeRefs(), current.bot.botId, patch, current)
  )
  // An edit of where it runs or answers is routed as on create.
  patch.bot &&= await inOriginThread(
    lookups,
    bot,
    patch.bot,
    Boolean((patch.on ?? current.on)?.length)
  )
}

/** Clients can't send the thread an automation was made in, so an edit keeps the saved one. */
export function withOriginThread<Target extends AutomationBotTarget | undefined>(
  next: Target,
  saved: Pick<AutomationBotTarget, 'originThread'>
): Target {
  return next && saved.originThread ? { ...next, originThread: saved.originThread } : next
}
