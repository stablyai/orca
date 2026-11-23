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

const MAX_COMMAND_WORDS = 8

const COMMANDS = new Map<string, ThreadMuteCommand>([
  ...MUTE_PHRASES.map((phrase) => [phrase, 'mute'] as const),
  ...UNMUTE_PHRASES.map((phrase) => [phrase, 'unmute'] as const)
])

/** How people address the thread's bot: its Slack user (`<@U…>`; a shared app's bots share one,
 *  told apart by the name after it) and its names (`@reviewer`). */
export type ThreadBot = {
  userId: string | null
  names: readonly string[]
  /** Other bots' names: after a shared app's mention, one of these addresses that bot instead. */
  others?: readonly string[]
}

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}@<>\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// The longest name first: "reviewer 2" (folder reviewer-2) before its bot's name "reviewer".
function afterName(rest: string, names: readonly string[]): string | null {
  const name = [...names]
    .sort((a, b) => b.length - a.length)
    .find((entry) => rest === entry || rest.startsWith(`${entry} `))
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
  const mentioned = rest !== normalized(text)
  if (commandOf(rest) !== null) {
    return true
  }
  // A mention may name its bot in the words after it ("@Orca Reviewer bot mute"); no phrase, with
  // its "please" and "thanks", runs past the last few words.
  const words = rest.split(' ')
  const tail = Math.max(1, words.length - MAX_COMMAND_WORDS)
  for (let drop = tail; mentioned && drop < words.length; drop++) {
    if (commandOf(words.slice(drop).join(' ')) !== null) {
      return true
    }
  }
  return false
}

/** Whether the message @mentions the bot anywhere, as its Slack user or by a whole name ("@reviewer"
 *  is not "@reviewer-2"). */
function mentionsBot(text: string, bot: ThreadBot): boolean {
  const lower = text.toLowerCase()
  const userId = bot.userId?.toLowerCase()
  return (
    (userId !== undefined && lower.includes(`<@${userId}>`)) ||
    bot.names.some((name) => {
      const at = `@${name.toLowerCase().trim()}`
      return (
        at.length > 1 &&
        lower.split(at).some((after, index) => index > 0 && !/^[\p{L}\p{N}_-]/u.test(after))
      )
    })
  )
}

/** Whether the message leads with the shared Slack user's mention and then another bot's name
 *  (longest first), so it is that bot's, not this one's. */
function addressesOtherBot(text: string, bot: ThreadBot): boolean {
  const userId = bot.userId?.toLowerCase()
  const rest = normalized(text)
  const prefix = `<@${userId}>`
  if (!userId || !bot.others?.length || !rest.startsWith(prefix)) {
    return false
  }
  const after = rest.slice(prefix.length).trimStart()
  const named = [
    ...bot.names.map((name) => ({ name: normalized(name), other: false })),
    ...bot.others.map((name) => ({ name: normalized(name), other: true }))
  ]
    .filter(({ name }) => name !== '' && (after === name || after.startsWith(`${name} `)))
    .sort((a, b) => b.name.length - a.name.length)
  return named[0]?.other === true
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
  // Another bot behind the same Slack app, named after its mention, leaves this one muted.
  if (addressesOtherBot(delivery.text, bot)) {
    return 'silence'
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
  /** The thread's bot and whether it is muted; `not_bot` for another chat's link, null for none. */
  read: (key: ConnectorConversation) => { botId: string; muted: boolean } | 'not_bot' | null
  /** Settles once the mute is on disk, so a command is never confirmed and then lost to a crash. */
  write: (key: ConnectorConversation, muted: boolean) => Promise<void>
  /** The names people @mention the bot by. */
  botNames: (botId: string) => string[]
  /** The names of this machine's other bots, which may share its Slack app. */
  otherBotNames: (botId: string) => string[]
  /** Settles after the thread's queued deliveries, as a start in the same poll writes its link. */
  queued: (key: ConnectorConversation) => Promise<unknown>
  /** Each thread's newest reply still deciding (its link being written, its mute being saved). */
  waiting: Map<string, Promise<unknown>>
  react: (
    botId: string,
    key: ConnectorConversation,
    messageRef: string,
    emoji: string
  ) => Promise<void>
}

const ACCEPTED = { outcome: 'accepted' } as const

/** Runs a handled send's effects under its durable delivery receipt, so a resend replays it. */
export type RecordHandled = (
  handled: () => Promise<typeof ACCEPTED>
) => Promise<ConnectorDeliveryResult>

/** A send this step holds: its result (accepted with no turn), or 'send' when it goes on once
 *  decided. `withBatch`: it goes on with its batch's follow-ups, which wait for it as one turn. */
export type ThreadMuteOutcome = {
  decided: Promise<ConnectorDeliveryResult | 'send'>
  withBatch?: true
}

/** The send's outcome when this step holds it; null when it goes on to the agent now. */
export function handleThreadMute(
  deps: ThreadMuteDeps,
  delivery: SendDelivery,
  record: RecordHandled
): ThreadMuteOutcome | null {
  const key = delivery.conversation
  const userId = key.source === 'slack' ? slackThreadBotUser(key.externalId) : null
  if (!userId) {
    return null
  }
  const id = JSON.stringify([key.source, key.externalId])
  // A reply behind one still deciding (its link being written, or its mute or unmute being saved)
  // waits its turn, so it is decided on what that one left and never overtakes it.
  const ahead = deps.waiting.get(id)
  if (ahead) {
    const after = ahead.catch(() => undefined)
    return {
      decided: hold(
        deps,
        id,
        after.then(() => decideNow(deps, delivery, record, userId))
      )
    }
  }
  const thread = deps.read(key)
  if (thread === 'not_bot') {
    return null
  }
  if (thread) {
    // Most replies to a thread that isn't muted are no command: they skip the bot's names.
    const applied =
      thread.muted || mayBeThreadMuteCommand(delivery.text)
        ? applyStep(deps, delivery, record, userId, thread)
        : null
    return applied && { ...applied, decided: hold(deps, id, applied.decided) }
  }
  // No link yet: a start in the same poll is still writing it. A likely command waits for it and
  // is then decided as any other; the rest go on now, batched as ever.
  if (!mayBeThreadMuteCommand(delivery.text)) {
    return null
  }
  const linkedAt = deps.queued(key)
  return {
    decided: hold(
      deps,
      id,
      linkedAt.then(() => decideNow(deps, delivery, record, userId))
    )
  }
}

async function decideNow(
  deps: ThreadMuteDeps,
  delivery: SendDelivery,
  record: RecordHandled,
  userId: string
): Promise<ConnectorDeliveryResult | 'send'> {
  const linked = deps.read(delivery.conversation)
  const applied =
    linked && linked !== 'not_bot' && applyStep(deps, delivery, record, userId, linked)
  return applied ? await applied.decided : 'send'
}

/** Keeps the thread's newest deciding reply until it settles, for the replies behind it. */
function hold(
  deps: ThreadMuteDeps,
  id: string,
  decided: Promise<ConnectorDeliveryResult | 'send'>
): Promise<ConnectorDeliveryResult | 'send'> {
  deps.waiting.set(id, decided)
  void decided
    .catch(() => undefined)
    .finally(() => {
      if (deps.waiting.get(id) === decided) {
        deps.waiting.delete(id)
      }
    })
  return decided
}

function applyStep(
  deps: ThreadMuteDeps,
  delivery: SendDelivery,
  record: RecordHandled,
  userId: string,
  thread: { botId: string; muted: boolean }
): ThreadMuteOutcome | null {
  const key = delivery.conversation
  // A reply with no mention and nothing like a command needs no names: most of a muted thread's.
  const plain = !delivery.text.includes('@') && !mayBeThreadMuteCommand(delivery.text)
  const step = threadMuteStep(thread.muted, delivery, {
    userId,
    names: plain ? [] : deps.botNames(thread.botId),
    others: plain ? [] : deps.otherBotNames(thread.botId)
  })
  if (step === 'send') {
    return null
  }
  if (step === 'silence') {
    return { decided: record(async () => ACCEPTED) }
  }
  if (step === 'unmute_and_send') {
    // Saved before it goes on, so its turn's receipt never stands for an unmute a crash lost; its
    // batch's follow-ups wait with it and still go as one turn.
    return { decided: deps.write(key, false).then(() => 'send' as const), withBatch: true }
  }
  const ref = delivery.asker?.messageRef
  // Saved before its receipt, so a crash between leaves the resend to decide it again; a save that
  // fails is refused and sent again. The emoji shows only a mute (or unmute) already on disk.
  const decided = deps.write(key, step === 'mute').then(() =>
    record(async () => {
      if (ref) {
        // The emoji is the only answer: a failed one leaves the thread muted (or not) all the same.
        void deps
          .react(thread.botId, key, ref, step === 'mute' ? MUTED_EMOJI : UNMUTED_EMOJI)
          .catch((error: unknown) =>
            console.warn('[connectors] could not react to a thread mute', error)
          )
      }
      return ACCEPTED
    })
  )
  return { decided }
}
