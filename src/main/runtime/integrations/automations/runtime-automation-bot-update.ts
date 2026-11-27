// The bot part of an update to a bot's automation: its agent and folder follow the bot, and its
// rules, places and chosen chat are looked up as on create.
import type {
  Automation,
  AutomationBotTarget,
  AutomationUpdateInput
} from '../../../../shared/automations/automation-definition'
import { originChatOf } from '../../../../shared/automation-bot-target'
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
  // The chat a thread's automation runs in was Orca's choice: closed before the save, the thread
  // still gets the answer (inOriginThread), so it isn't refused here. A chat named by id still is.
  const ownChat =
    input.bot?.chat !== undefined && input.bot.chat.sessionId === originChatOf(input.bot)
  const inChat = ownChat ? input.bot : await withCheckedBotChat(input.bot, bot, lookups.botChat)
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
  const chatId = originChatOf(target)
  if (!target?.originThread || !bot) {
    return target
  }
  // The chat is looked up only when the target would run there.
  const originChat =
    hasEvents || target.agentSetup || !chatId ? undefined : await lookups.botChat(bot, chatId)
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
  // An edit of where it runs or answers, or of whether events start it, is routed as on create.
  const hasEvents = Boolean((patch.on ?? current.on)?.length)
  if (patch.bot) {
    patch.bot = await inOriginThread(lookups, bot, patch.bot, hasEvents)
  } else if (patch.on !== undefined && current.bot.originThread) {
    const routed = await inOriginThread(lookups, bot, current.bot, hasEvents)
    if (JSON.stringify(routed) !== JSON.stringify(current.bot)) {
      patch.bot = routed
    }
  }
}

/** Clients can't send the thread an automation was made in, so an edit keeps the saved one. */
export function withOriginThread<Target extends AutomationBotTarget | undefined>(
  next: Target,
  saved: Pick<AutomationBotTarget, 'originThread'>
): Target {
  return next && saved.originThread ? { ...next, originThread: saved.originThread } : next
}
