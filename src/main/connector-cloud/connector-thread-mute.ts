// Per-thread mute for a bot's Slack thread, decided before the agent sees the message: "mute" (or
// "be quiet", "stop responding in this thread") stops later replies reaching it until an @mention
// or "unmute". The bot's own posts (a background run's result, an automation) still go out.
import type {
  ConnectorConversation,
  ConnectorDeliveryResult
} from '../../shared/connectors/connector-cloud-contract'
import type { SendDelivery } from './connector-deliveries'

export type ThreadMuteCommand = 'mute' | 'unmute'

// Whole messages only, and none a one-word answer to a question could be ("quiet").
const MUTE_PHRASES = [
  'mute',
  'mute this',
  'mute here',
  'mute this thread',
  'mute thread',
  'be quiet',
  'stay quiet',
  'go quiet',
  'stop responding',
  'stop responding here',
  'stop responding in this thread',
  'stop replying',
  'stop replying here',
  'stop replying in this thread'
]
const UNMUTE_PHRASES = [
  'unmute',
  'unmute this',
  'unmute here',
  'unmute this thread',
  'unmute thread',
  'start responding',
  'start responding again',
  'start replying again',
  'resume responding',
  'you can respond again'
]

const COMMANDS = new Map<string, ThreadMuteCommand>([
  ...MUTE_PHRASES.map((phrase) => [phrase, 'mute'] as const),
  ...UNMUTE_PHRASES.map((phrase) => [phrase, 'unmute'] as const)
])

/** How people address the thread's bot: its Slack user (`<@U…>`; a shared app's bots share one,
 *  told apart by the name after it) and its names (`@reviewer`). */
export type ThreadBot = { userId: string | null; names: readonly string[] }

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}@<>\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function afterName(rest: string, names: readonly string[]): string | null {
  const name = names.find((entry) => rest === entry || rest.startsWith(`${entry} `))
  return name === undefined ? null : rest.slice(name.length).trimStart()
}

/** The message past its leading mentions of `bot`; null when one names someone else, so "@Bob
 *  mute" or a mute for another bot never mutes this one. `any` takes every mention (batching, which
 *  only needs to keep a likely command out of a turn). */
function pastMentions(text: string, bot: ThreadBot | 'any'): string | null {
  let rest = normalized(text)
  const names =
    bot === 'any' ? [] : bot.names.map((name) => normalized(name)).filter((name) => name !== '')
  const userId = bot === 'any' ? null : bot.userId?.toLowerCase()
  for (;;) {
    const slack = /^<@([^>]+)>\s*/.exec(rest)
    const token = /^@\S+\s*/.exec(rest)
    if (slack) {
      if (bot !== 'any' && slack[1] !== userId) {
        return null
      }
      rest = rest.slice(slack[0].length)
      rest = afterName(rest, names) ?? rest
    } else if (token) {
      // "@reviewer", or a shared app's "@Orca reviewer".
      const named = afterName(rest.slice(1), names) ?? afterName(rest.slice(token[0].length), names)
      if (bot !== 'any' && named === null) {
        return null
      }
      rest = named ?? rest.slice(token[0].length)
    } else {
      return rest
    }
  }
}

function commandOf(rest: string): ThreadMuteCommand | null {
  const plain = rest
    .replace(/^please /, '')
    .replace(/ please$/, '')
    .replace(/ thanks$/, '')
  return COMMANDS.get(plain) ?? null
}

/** The command a whole message is, past leading mentions of the bot and a "please"; null for
 *  anything else ("mute the video", "don't mute", a question like "mute?"). */
export function threadMuteCommand(text: string, bot: ThreadBot): ThreadMuteCommand | null {
  const rest = text.trim().endsWith('?') ? null : pastMentions(text, bot)
  return rest === null ? null : commandOf(rest)
}

/** Whether a message may be a mute command for some bot, its handle unknown: kept out of batches. */
export function mayBeThreadMuteCommand(text: string): boolean {
  const rest = pastMentions(text, 'any') ?? ''
  return commandOf(rest) !== null || commandOf(rest.replace(/^\S+ /, '')) !== null
}

/** Whether the message @mentions the bot anywhere, as its Slack user or by name. */
function mentionsBot(text: string, bot: ThreadBot): boolean {
  const words = ` ${normalized(text)} `
  const userId = bot.userId?.toLowerCase()
  return (
    (userId !== undefined && words.includes(`<@${userId}>`)) ||
    bot.names.some((name) => {
      const plain = normalized(name)
      return plain !== '' && words.includes(` @${plain} `)
    })
  )
}

/** What a send to a bot's thread does: a command is handled here and never reaches the agent; a
 *  muted thread silences any send that doesn't mention the bot; a mention unmutes and goes on. */
export type ThreadMuteStep = 'mute' | 'unmute' | 'silence' | 'unmute_and_send' | 'send'

export function threadMuteStep(
  muted: boolean,
  delivery: Pick<SendDelivery, 'text' | 'bareMention' | 'mentioned' | 'resume'>,
  bot: ThreadBot
): ThreadMuteStep {
  // Resume is pressed on the bot's own failed turn: it goes on, and may still be refused, so it
  // leaves the mute as it was.
  if (delivery.resume) {
    return 'send'
  }
  const command = threadMuteCommand(delivery.text, bot)
  if (command) {
    return command
  }
  if (!muted) {
    return 'send'
  }
  // `mentioned` comes only from a newer connector service; until then the bot's own mention in the
  // text counts.
  return delivery.mentioned || delivery.bareMention || mentionsBot(delivery.text, bot)
    ? 'unmute_and_send'
    : 'silence'
}

/** The bot's Slack user from a thread id (`T:C:ts:UBOT`); null for a DM (`T:D:D:UBOT`), which has
 *  no thread to mute. */
export function slackThreadBotUser(externalId: string): string | null {
  const [, , thread, userId] = externalId.split(':')
  return thread && /^\d+(?:\.\d+)?$/.test(thread) && userId ? userId : null
}

export const MUTED_EMOJI = ':mute:'
export const UNMUTED_EMOJI = ':loud_sound:'

export type ThreadMuteDeps = {
  /** The thread's bot and whether it is muted; null for a conversation that isn't a bot's thread here. */
  read: (key: ConnectorConversation) => { botId: string; muted: boolean } | null
  write: (key: ConnectorConversation, muted: boolean) => void
  /** The names people @mention the bot by. */
  botNames: (botId: string) => string[]
  /** Settles after the thread's queued deliveries, as a start in the same poll writes its link. */
  queued: (key: ConnectorConversation) => Promise<unknown>
  react: (
    botId: string,
    key: ConnectorConversation,
    messageRef: string,
    emoji: string
  ) => Promise<void>
}

const ACCEPTED: ConnectorDeliveryResult = { outcome: 'accepted' }

/** Settles a send this step handled (accepted, no turn); null when it goes on to the agent. */
export function handleThreadMute(
  deps: ThreadMuteDeps,
  delivery: SendDelivery
): Promise<ConnectorDeliveryResult> | null {
  const key = delivery.conversation
  const userId = key.source === 'slack' ? slackThreadBotUser(key.externalId) : null
  if (!userId) {
    return null
  }
  const thread = deps.read(key)
  // Most replies to a thread that isn't muted are no command: they skip the bot's names.
  if (thread && !thread.muted && !mayBeThreadMuteCommand(delivery.text)) {
    return null
  }
  if (thread) {
    return applyStep(deps, delivery, userId, thread)
  }
  // No link yet: a start in the same poll is still writing it. Only a starting thread's own command
  // waits for it; anything else goes on as before.
  if (!mayBeThreadMuteCommand(delivery.text)) {
    return null
  }
  return deps.queued(key).then(() => {
    const linked = deps.read(key)
    const settled = linked && applyStep(deps, delivery, userId, linked)
    // Every start links its thread to a bot, so this one left none to send to.
    return settled ?? { outcome: 'refused', reason: 'external_conversation_not_found' }
  })
}

function applyStep(
  deps: ThreadMuteDeps,
  delivery: SendDelivery,
  userId: string,
  thread: { botId: string; muted: boolean }
): Promise<ConnectorDeliveryResult> | null {
  const key = delivery.conversation
  const step = threadMuteStep(thread.muted, delivery, {
    userId,
    names: deps.botNames(thread.botId)
  })
  if (step === 'send') {
    return null
  }
  if (step !== 'silence') {
    deps.write(key, step === 'mute')
  }
  if (step === 'unmute_and_send') {
    return null
  }
  const ref = delivery.asker?.messageRef
  if (ref && step !== 'silence') {
    // The emoji is the only answer: a failed one leaves the thread muted (or not) all the same.
    void deps
      .react(thread.botId, key, ref, step === 'mute' ? MUTED_EMOJI : UNMUTED_EMOJI)
      .catch((error: unknown) =>
        console.warn('[connectors] could not react to a thread mute', error)
      )
  }
  return Promise.resolve(ACCEPTED)
}
