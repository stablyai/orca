// Whether a bot's run may use the Google accounts on its host: off for every bot until its owner turns
// it on. Then it acts as the owner like gh and orca linear: chats follow the bot's Who can ask, and
// automation runs use it for their own job (an email-triggered one included). An event's run acts for
// the automation's creator; what the event says is content, marked so on any request it sends on.
import type { Bot } from '../../shared/bot-types'
import {
  googleBotConnectState,
  type GoogleBotConnectState
} from '../../shared/google/google-bot-connect-state'
import { getGoogleConnect } from '../google/google-connect'
import { botOfCaller, type BotCallerRuntime } from './bot-of-caller'

/** Null when the bot may use Google; else the one sentence to act on. A non-bot caller is the owner. */
export function botGoogleRefusal(bot: Pick<Bot, 'name' | 'google'> | null): string | null {
  if (!bot || bot.google === true) {
    return null
  }
  return `Google is off for ${bot.name}. Run \`orca bot connectors --offer google\` to ask your owner.`
}

/** Null when the calling run (a bot's chat, automation or Look around) may use Google; else why not. */
export function readGoogleRefusal(
  runtime: BotCallerRuntime,
  callerSessionId: string | undefined,
  pairedDeviceId: string | undefined
): string | null {
  return botGoogleRefusal(botOfCaller(runtime, callerSessionId, pairedDeviceId))
}

/** Owner-only changes to this host's Google setup are refused from a bot's chat and agents' CLI. */
export const GOOGLE_OWNER_ONLY =
  'Only your owner can change Google on this computer; ask them in Orca.'

/** This host's Google, read for one bot; a host without Google has no app. */
export function hostGoogleBotState(bot: Pick<Bot, 'google'>): GoogleBotConnectState {
  const connect = getGoogleConnect()
  return googleBotConnectState({
    allowed: bot.google === true,
    client: connect?.client() ?? null,
    accounts: connect?.accounts() ?? []
  })
}
