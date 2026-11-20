// Limits on bots handing work to each other without a person. What holds: a native bot request Orca
// recorded, with its lineage intact on this host, is admitted up to 12 hand-offs and refused at the
// 13th; one runtime limits each ordered bot pair to 30 requests per rolling 10 minutes, counted when
// each is reserved or admitted (a row stored before milliseconds counts to its second's end; that
// boundary has no unit test, as SQLite's now can't be held). Slack wakes are a separate per-recipient
// heuristic: each bot counts other bots' posts that woke it in a thread, is told to stop on the 12th,
// and isn't woken again while 12 are visible in its journal since a person last wrote.
//
// Not covered: chains that cross a paired host (peer mail arrives without its sender bot or depth);
// Slack wakes the connector batches into one delivery (only its first message is gated) or that are
// still queued unseen; a thread-wide Slack count (two alternating bots get about twice the hand-offs);
// a worker's chain, read from its chat's turn when it sends, not when it started; a turn an agent's
// own message opens (no parent request, so a new chain); the thread-wide Slack reset, kept in memory
// and lost on restart; a chat's journal read whole, so another conversation's posts or replies in a
// shared or relinked chat count or reset too. The owner's line is best effort (a passive status line,
// none in a group room, marked told before it is written).
import type { Bot } from '../../shared/bot-types'
import type { BotRequestRefusal } from './bot-request-policy'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { BotRequestPairLimit } from '../runtime/orchestration/db/bot-requests/bot-request-store'
import { isBotGroupMemberSession } from '../../shared/bots/bot-group'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import { noteInChat } from './bot-chat-status-line'

/** Hand-offs in a row one chain may take; the next is not sent. */
export const BOT_CHAIN_LIMIT = 12
/** Requests one bot may send another within the window, whatever the chain. */
export const BOT_PAIR_LIMIT = { requests: 30, minutes: 10 }

const BOT_CHAIN_LIMIT_REFUSAL: BotRequestRefusal = {
  code: 'bot_request_chain_limit',
  message: `This chain has passed ${BOT_CHAIN_LIMIT} bot hand-offs in a row, so Orca didn't send it. Don't try another way: finish what you can here, and tell whoever asked that the bots stopped after ${BOT_CHAIN_LIMIT} hand-offs and that a reply to you lets them continue.`
}

function botPairLimitRefusal(target: string, minutesLeft: number): BotRequestRefusal {
  return {
    code: 'bot_request_rate_limit',
    message: `You have made ${BOT_PAIR_LIMIT.requests} requests to ${target} in the last ${BOT_PAIR_LIMIT.minutes} minutes, so Orca didn't send this one. Don't retry now: finish what you can here, and tell whoever asked that you can ask ${target} again in about ${minutesLeft} min.`
  }
}

/** Whole minutes until a request leaves the window, at least one. */
function minutesUntil(at: number | null, now: number): number {
  return at === null ? BOT_PAIR_LIMIT.minutes : Math.max(1, Math.ceil((at - now) / 60_000))
}

/** A request a limit stopped: what the sending bot is told, and the owner's line in its chat. */
type BotRequestLimitStop = { refusal: BotRequestRefusal; chatLine: string }

type Sending = { bot: Pick<Bot, 'id' | 'name'> | null; sessionId: string | null }

// Refusals the owner was already told of, by refusal and send; a retried send adds no second line.
const noticed = new Set<string>()
const NOTICED_KEPT = 500

function botChainLimitStop(sender: string, target: string): BotRequestLimitStop {
  return {
    refusal: BOT_CHAIN_LIMIT_REFUSAL,
    chatLine: `${sender} didn't hand this to ${target}: the bots have handed this back and forth ${BOT_CHAIN_LIMIT} times in a row without a person, so Orca stopped it to break the loop. Reply here to let them continue.`
  }
}

function botPairLimitStop(
  sender: string,
  target: string,
  minutesLeft: number
): BotRequestLimitStop {
  return {
    refusal: botPairLimitRefusal(target, minutesLeft),
    chatLine: `${sender} didn't send this to ${target}: it has sent ${target} ${BOT_PAIR_LIMIT.requests} requests in a row, so Orca paused it. ${sender} can ask ${target} again in about ${minutesLeft} min.`
  }
}

/** Refuses a request past its chain's hand-offs. The owner's own agents count hand-offs too. */
function refuseOverChainLimit(
  sending: Sending,
  target: Pick<Bot, 'name'>,
  depth: number,
  sendKey: string | undefined
): void {
  if (depth > BOT_CHAIN_LIMIT) {
    stop(botChainLimitStop(sending.bot?.name ?? 'Your agent', target.name), sending, sendKey)
  }
}

/** The quota a send takes in its admission, refusing the send past it; only a bot's send has one. */
export function botPairLimitOf(
  sending: Sending,
  target: Pick<Bot, 'name'>,
  sendKey: string | undefined
): BotRequestPairLimit | undefined {
  return sending.bot
    ? {
        ...BOT_PAIR_LIMIT,
        refuse: (oldestLeavesAt) => {
          const minutesLeft = minutesUntil(oldestLeavesAt, Date.now())
          const name = sending.bot?.name ?? 'Your agent'
          return stop(botPairLimitStop(name, target.name, minutesLeft), sending, sendKey)
        }
      }
    : undefined
}

/** The owner's line for one refusal, at most once per key in this process (best effort: a failed
 *  write isn't retried, and a restart or eviction may repeat it). Without a key, every refusal is
 *  its own. */
export function noteLimitOnce(sessionId: string, key: string | undefined, line: string): void {
  if (key !== undefined) {
    if (noticed.has(key)) {
      return
    }
    noticed.add(key)
    const [oldest] = noticed
    if (noticed.size > NOTICED_KEPT && oldest) {
      noticed.delete(oldest)
    }
  }
  noteInChat(sessionId, line)
}

// Sends past their pair's hold in this process, by pair: the message ids each will be stored under.
const inFlight = new Map<string, Set<string>>()

/**
 * Holds a place in the pair's quota for a send before anything is made or shown for it (the target's
 * Home Chat included): one past the quota, counting sends still on their way, is refused here. A send
 * counts once: by its stored request once reserved or admitted, by its hold until then. The admission
 * counts again as it stores. Returns the release, run once the send settles.
 */
function holdPairPlace(
  db: OrchestrationDb,
  sending: Sending,
  target: Pick<Bot, 'id' | 'name'>,
  send: { sendKey?: string; messageId: string }
): () => void {
  const limit = botPairLimitOf(sending, target, send.sendKey)
  if (!limit || !sending.bot) {
    return () => {}
  }
  const pair = JSON.stringify([sending.bot.id, target.id])
  const held = inFlight.get(pair) ?? new Set<string>()
  const sent = db.botRequestsSentWithin(
    { fromBotId: sending.bot.id, toBotId: target.id },
    limit.minutes
  )
  const unstored = [...held].filter((messageId) => !db.getBotRequest(messageId)).length
  if (sent.count + unstored >= limit.requests) {
    limit.refuse(sent.oldestLeavesAt)
  }
  inFlight.set(pair, held.add(send.messageId))
  return () => {
    held.delete(send.messageId)
    if (held.size === 0 && inFlight.get(pair) === held) {
      inFlight.delete(pair)
    }
  }
}

/** Refuses a send past its chain's hand-offs, then holds its place in the pair's quota. */
export function holdUnderLimits(
  db: OrchestrationDb,
  sending: Sending,
  target: Pick<Bot, 'id' | 'name'>,
  depth: number,
  send: { sendKey?: string; messageId: string }
): () => void {
  refuseOverChainLimit(sending, target, depth, send.sendKey)
  return holdPairPlace(db, sending, target, send)
}

/** Tells the owner in the sending chat, once per refused send (a group's room shows nothing),
 *  and the sender by a typed refusal. */
function stop(limit: BotRequestLimitStop, sending: Sending, sendKey: string | undefined): never {
  if (sending.sessionId && !isBotGroupMemberSession(sending.sessionId)) {
    const key = sendKey ? `${limit.refusal.code}:${sendKey}` : undefined
    noteLimitOnce(sending.sessionId, key, limit.chatLine)
  }
  throw new OrchestrationError(limit.refusal.code, limit.refusal.message)
}

/** What a Slack post another Orca bot wrote does to the bot it wakes, by how many such wakes came in a
 *  row in that chat (this one included) since a person last wrote there. */
export type BotWakeChain =
  | { kind: 'wake' }
  /** The last one allowed: the bot answers it, wakes no bot, and says it stopped. */
  | { kind: 'last'; note: string }
  | { kind: 'stop' }

export const BOT_WAKE_LAST_LINE = `Orca bots have handed this back and forth ${BOT_CHAIN_LIMIT} times in a row, so I've stopped here to save usage. Reply to me here to continue.`

export function botWakeChain(wakesInARow: number): BotWakeChain {
  if (wakesInARow < BOT_CHAIN_LIMIT) {
    return { kind: 'wake' }
  }
  if (wakesInARow === BOT_CHAIN_LIMIT) {
    return {
      kind: 'last',
      note: `Other Orca bots' posts have woken you ${BOT_CHAIN_LIMIT} times in a row in this thread with no person writing in between. Answer this one without @mentioning any Orca bot, and end your reply with this line, word for word: ${BOT_WAKE_LAST_LINE}`
    }
  }
  return { kind: 'stop' }
}

/** The owner's line in a bot's chat when Orca didn't wake it for another bot's Slack post. */
export function botWakeStoppedChatLine(poster: string): string {
  return `Orca didn't pass ${poster}'s Slack post to this chat: Orca bots have handed this thread back and forth ${BOT_CHAIN_LIMIT} times in a row, so Orca stopped it to break the loop. Reply in the thread, or here, to let it continue.`
}
