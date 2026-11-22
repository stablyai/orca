// A model or option picked in one of a bot's own conversations belongs to that bot, not to the owner's chats.
import { botLaunchWithPicks } from '../../shared/bots/bot-launch'
import type { NativeChatSessionOptionSettingsMutation } from '../../shared/native-chat/input/native-chat-session-options'
import type { BotController } from './bot-controller'
import { botOfSession } from './bot-session-tabs'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { AgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service-contract'
import { confirmsListedEffortAtSend } from '../../shared/agent-session/options/model-catalog/agent-model-catalog-ownership'

type SessionLookup = NonNullable<Parameters<typeof botOfSession>[2]> & {
  deps?: { modelCatalog?: Pick<AgentModelCatalogService, 'peek'> }
}

/**
 * Keeps picks made in a bot's conversation (its Chat, a look-around, an automation run) as that
 * bot's model and options, so they never become the owner's default for every new chat. True when
 * the picks belonged to a bot, whether or not its launch changed; false leaves them to the owner's
 * chat defaults.
 */
export async function keepSessionPicksOnBot(
  bots: Pick<BotController, 'enabled' | 'list' | 'update'>,
  mutation: NativeChatSessionOptionSettingsMutation,
  host?: SessionLookup
): Promise<boolean> {
  if (mutation.type !== 'apply-picks' || !mutation.sessionId || !bots.enabled()) {
    return false
  }
  const lookup = host ?? getStructuredAgentSessionHost()
  const bot = botOfSession(bots, mutation.sessionId, lookup)
  if (!bot) {
    return false
  }
  // A conversation in the bot's home on another agent still is not the owner's chat to remember.
  if (bot.agent !== mutation.agent) {
    return true
  }
  // A bot runs unattended, so an effort no chat has confirmed stays in the chat it was picked in.
  const models = confirmsListedEffortAtSend(mutation.agent)
    ? (lookup?.deps?.modelCatalog?.peek(mutation.sessionId)?.models ?? [])
    : null
  const picks = mutation.picks.filter(
    (pick) =>
      !models ||
      pick.optionId !== 'effort' ||
      models.some((model) => model.id === pick.modelId && model.effortsKnown !== false)
  )
  if (sameLaunch(botLaunchWithPicks(bot.launch, picks), bot.launch)) {
    return true
  }
  await bots
    .update(bot.id, (current) =>
      current.agent === mutation.agent
        ? { launch: botLaunchWithPicks(current.launch, picks) ?? null }
        : {}
    )
    .catch((error: unknown) => {
      console.warn("[bots] could not keep a chat's model pick on its bot", error)
    })
  return true
}

function sameLaunch(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}
