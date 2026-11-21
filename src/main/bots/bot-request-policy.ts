// Whether one bot (or anything acting for one) may mail another: the rules Orca applies at the
// receiving bot, whatever address named it. Each refusal is one sentence that says what to do instead.
// Whom the request is for travels with it as information and never refuses it: every bot runs as the owner.
import type { Bot } from '../../shared/bot-types'
import { botAddressArgument, botOfAddress, botSendTarget } from '../../shared/bot-roster'
import type { CachedPairedBotRoster } from './paired-bot-rosters'

/** A bot takes these kinds of mail from outside itself; status is information, with no job in it. */
export const BOT_REQUEST_PURPOSES = ['status', 'handoff', 'question'] as const
export type BotRequestPurpose = (typeof BOT_REQUEST_PURPOSES)[number]

/** Status informs: nothing comes back, so Orca never waits on it or tells its sender how it ended. */
export function awaitsAnswer(purpose: BotRequestPurpose): boolean {
  return purpose !== 'status'
}

export type BotRequestRefusal = { code: BotRequestRefusalCode; message: string }
export type BotRequestRefusalCode =
  | 'bots_disabled'
  | 'bot_not_found'
  | 'bot_chat_not_found'
  | 'bot_paused'
  | 'bot_self'
  | 'bot_request_type'
  | 'bot_request_worker'

type TargetBot = Pick<Bot, 'id' | 'name' | 'paused'>

export function isBotRequestPurpose(type: string | undefined): type is BotRequestPurpose {
  return BOT_REQUEST_PURPOSES.some((purpose) => purpose === type)
}

/** Why an address names no one here, listing who is. Given `paired`, a send's miss also names the
 *  paired computers last read to have that name, with the `--on` that reaches each. */
export function botNotFound(
  name: string,
  bots: readonly Pick<Bot, 'name'>[],
  paired?: readonly CachedPairedBotRoster[]
): BotRequestRefusal {
  const elsewhere = paired ? pairedSendsTo(name, paired) : null
  if (elsewhere) {
    return { code: 'bot_not_found', message: elsewhere }
  }
  const here =
    bots.length === 0
      ? `There is no bot named ${name} and no other bot on this computer, so do the work yourself or tell the asker who could.`
      : `There is no bot named ${name} on this computer (its bots: ${bots.map((bot) => botAddressArgument(bot.name)).join(', ')}), so pick one of those or do the work yourself.`
  return {
    code: 'bot_not_found',
    message: paired ? `${here} One on a paired computer needs --on <computer> before --to.` : here
  }
}

// Read from the cache only: a send never waits on a paired computer to refuse.
function pairedSendsTo(name: string, paired: readonly CachedPairedBotRoster[]): string | null {
  const matches = paired.flatMap(({ server, bots }) => {
    const match = botOfAddress(bots, name)
    return match ? [{ name: match.name, server }] : []
  })
  if (matches.length === 0) {
    return null
  }
  const sends = matches.map(
    (match) =>
      `${match.name} is on ${match.server.name}: use ${botSendTarget(botAddressArgument(match.name), match.server)}`
  )
  return `There is no bot named ${name} on this computer. ${sends.join('; ')}.`
}

export const BOT_REQUEST_TYPE_REFUSAL: BotRequestRefusal = {
  code: 'bot_request_type',
  message:
    'A bot takes --type status (information: no job, nothing comes back), --type question (it answers you) or --type handoff (it takes over the job), so send it again as one of those.'
}

export const BOT_REQUEST_WORKER_HANDOFF_REFUSAL: BotRequestRefusal = {
  code: 'bot_request_worker',
  message:
    'Giving the job away is the call of the bot that started you, so report to it, or send --type question or --type status if you only need an answer or want to inform.'
}

export const BOT_REQUEST_GROUP_WORKER_REFUSAL: BotRequestRefusal = {
  code: 'bot_request_worker',
  message: "A group's bots talk in the group's own chats, so report to the bot that started you."
}

export type BotRequestCheck = {
  enabled: boolean
  target: TargetBot
  /** The bot the sender acts for; null for the owner's own agents. */
  senderBotId: string | null
  /** Whether the mail names a chat other than the sending one: a bot's other chats are other agents. */
  toOtherChat: boolean
  type: string | undefined
  /** Sent by a worker that bot started, acting for it. */
  fromWorker?: boolean
}

/** Every rule but the duplicate send, which the database checks as it stores. */
export function botRequestRefusal(check: BotRequestCheck): BotRequestRefusal | null {
  const { target } = check
  if (!check.enabled) {
    return {
      code: 'bots_disabled',
      message: 'Bots are off on this computer, so do the work yourself.'
    }
  }
  if (check.senderBotId === target.id && !check.toOtherChat) {
    return check.fromWorker
      ? {
          code: 'bot_self',
          message: "That's the chat that started you, so report to it as usual."
        }
      : {
          code: 'bot_self',
          message:
            "That's this chat, so do the work here, or send it to another of your chats with --chat <id> (`orca bot chats` lists them) or --chat new."
        }
  }
  if (target.paused) {
    return {
      code: 'bot_paused',
      message: `${target.name} is paused, so do the work yourself or tell the asker to try again once its owner unpauses it.`
    }
  }
  if (!isBotRequestPurpose(check.type)) {
    return BOT_REQUEST_TYPE_REFUSAL
  }
  return check.fromWorker && check.type === 'handoff' ? BOT_REQUEST_WORKER_HANDOFF_REFUSAL : null
}
