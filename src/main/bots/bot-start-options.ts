// The model and options a bot's new conversation starts on.
import type { Bot } from '../../shared/bot-types'
import { newChatPermissionMode } from '../../shared/agent-launch/permissions/agent-chat-permission-mode'
import { botLaunchSeedOptions } from '../../shared/bots/bot-launch'
import { explicitStructuredLaunchSeedOptions } from '../../shared/native-chat/input/session-options/native-chat-session-option-defaults'
import { supportedStructuredSeedOptions } from '../runtime/agent-session/installation/structured-agent-runtime-metadata'

export type BotLaunchSettings = Parameters<typeof explicitStructuredLaunchSeedOptions>[0]

export function botStartPermission(bot: Pick<Bot, 'agent' | 'permissionMode'>) {
  return bot.permissionMode ? newChatPermissionMode(bot.agent, bot.permissionMode) : null
}

/**
 * The bot's own launch comes first. A conversation the owner opens keeps the chat defaults otherwise.
 * Background work (Look around, tidy-up, an automation's new conversation) never reads the model
 * remembered from the owner's last chat pick: without the bot's own model it takes the owner's
 * explicit default for the agent (Settings > Agents), else the agent's own default. A launch that
 * sets only options keeps them over that default.
 */
export function botStartOptions(
  settings: () => BotLaunchSettings,
  bot: Pick<Bot, 'agent' | 'launch'>,
  background: boolean
): Record<string, string> {
  const own = botLaunchSeedOptions(bot.launch)
  if (!background || own?.model) {
    return own ?? {}
  }
  return {
    ...explicitStructuredLaunchSeedOptions(settings(), bot.agent),
    ...own
  }
}

export function botBackgroundStartOptions(
  settings: BotLaunchSettings,
  bot: Pick<Bot, 'agent' | 'launch'>
): Record<string, string> {
  return supportedStructuredSeedOptions(
    bot.agent,
    botStartOptions(() => settings, bot, true)
  )
}
