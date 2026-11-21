// The model and options a bot's new conversation starts on.
import type { Bot } from '../../shared/bot-types'
import { botLaunchSeedOptions } from '../../shared/bots/bot-launch'
import { applyAgentCopyById } from '../../shared/agent-launch/catalog/agent-copies'
import { explicitStructuredLaunchSeedOptions } from '../../shared/native-chat/input/session-options/native-chat-session-option-defaults'

type LaunchSettings = Parameters<typeof explicitStructuredLaunchSeedOptions>[0]

/**
 * The bot's own launch comes first. A conversation the owner opens keeps the chat defaults otherwise.
 * Background work (Look around, tidy-up, an automation's new conversation) never reads the model
 * remembered from the owner's last chat pick: without the bot's own model it takes the owner's
 * explicit default for the agent (Settings > Agents), else the agent's own default. A launch that
 * sets only options keeps them over that default. A bot that runs as an agent copy takes the copy's
 * explicit default instead.
 */
export function botStartOptions(
  settings: () => LaunchSettings,
  bot: Pick<Bot, 'agent' | 'launch' | 'agentCopy'>,
  background: boolean
): Record<string, string> {
  const own = botLaunchSeedOptions(bot.launch)
  if (!background || own?.model) {
    return own ?? {}
  }
  const saved = settings()
  return {
    ...explicitStructuredLaunchSeedOptions(
      saved && applyAgentCopyById(saved, bot.agentCopy ?? undefined),
      bot.agent
    ),
    ...own
  }
}
