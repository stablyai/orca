import {
  botItemHostWaitingAsk,
  botItemQuestionPairing
} from '../../../../src/shared/bots/bot-item-question-answers'
import {
  parseBotItemEventId,
  type BotItem,
  type BotItemEvent
} from '../../../../src/shared/bots/bot-items'
import type { MobileNativeChatAskDraft } from '../../session/native-chat/input/prompts/use-mobile-native-chat-ask-answers'

// Each item's unsent answer card, for this app session: leaving the item and opening it again shows
// the picks and typed words as they were. One per item, for the ask it answers: it goes when the
// host's read names a newer ask or the item closes, and a newer ask's card takes its place.
// An open item page reads the host for its own card; the bot's item list reads every item's state,
// so a card whose item closed elsewhere after you left it goes with the next list read. No count
// cap: a card can only drop on the host's word, so an open item's unsent words are never lost, and
// what stays is one card per item still open when last read.
// What the list can't retire, as it holds no waiting ask: a card whose ask was answered or replaced
// elsewhere on an item that stays open (until that item's page opens again or it closes), and cards
// of items closed past the Closed pages read since, deleted, or on a host removed.
// Each is one entry per item ever typed into (about 1 KiB), in memory for this app session only.
// The clock counts what the phone saw in order, not the host's: a slow page read that still shows
// the ask waiting re-stamps its card, so a list read asked before that can't drop it.
// Cards are held by the bot on its host, then by item, so a list read of a bot holding no card
// looks at none of its rows, however many cards other bots hold.
type Draft = {
  askId: string
  questions: Readonly<Record<string, MobileNativeChatAskDraft>>
  /** When the card was last saved or shown waiting, so a list read asked earlier can't drop it. */
  at: number
}
const drafts = new Map<string, Map<string, Draft>>()
let clock = 0

function botCardsKey(hostKey: string, botId: string): string {
  return `${hostKey}\0${botId}`
}

/** The key of an item's card: the item on its host, as two hosts can hold the same ids. */
export function botItemAskCardKey(hostKey: string, botId: string, uid: string): string {
  return `${botCardsKey(hostKey, botId)}\0${uid}`
}

/** The bot's part and the item's uid of a `botItemAskCardKey` (a uid holds no NUL). */
function splitItemKey(itemKey: string): { bot: string; uid: string } {
  const at = itemKey.lastIndexOf('\0')
  return { bot: itemKey.slice(0, at), uid: itemKey.slice(at + 1) }
}

function findDraft(itemKey: string): Draft | undefined {
  const { bot, uid } = splitItemKey(itemKey)
  return drafts.get(bot)?.get(uid)
}

function dropDraft(itemKey: string): void {
  const { bot, uid } = splitItemKey(itemKey)
  const cards = drafts.get(bot)
  if (cards?.delete(uid) && cards.size === 0) {
    drafts.delete(bot)
  }
}

/** Taken before a list read is asked: cards saved after it are newer than what the read says. */
export function botItemAskCardDraftsClock(): number {
  return clock
}

/** The card's answers for `askId` on the item `itemKey` names on its host. */
export function readBotItemAskCardDraft(
  itemKey: string,
  askId: string
): Readonly<Record<string, MobileNativeChatAskDraft>> | undefined {
  const draft = findDraft(itemKey)
  return draft?.askId === askId ? draft.questions : undefined
}

/** Keeps the whole card as it stands, so a line left untouched since a failed Send stays too. */
export function saveBotItemAskCardDraft(
  itemKey: string,
  askId: string,
  questions: Readonly<Record<string, MobileNativeChatAskDraft>>
): void {
  const kept = Object.fromEntries(
    Object.entries(questions).filter(([, { picks, other }]) => picks.length > 0 || other)
  )
  if (Object.keys(kept).length === 0) {
    dropDraft(itemKey)
    return
  }
  const { bot, uid } = splitItemKey(itemKey)
  let cards = drafts.get(bot)
  if (!cards) {
    cards = new Map()
    drafts.set(bot, cards)
  }
  cards.set(uid, { askId, questions: kept, at: ++clock })
}

/** Drops the item's card once the host's read shows its ask over: the item closed, the read names
 *  a newer ask, or it names none and the loaded events hold the ask with no line still waiting.
 *  An ask whose event isn't loaded yet (older history still reading) keeps its card, and so does
 *  one newer than the ask an older item read still names (a read split across two moments). */
export function retireBotItemAskCardDraft(
  itemKey: string,
  item: BotItem,
  events: readonly BotItemEvent[]
): void {
  const draft = findDraft(itemKey)
  if (!draft) {
    return
  }
  const named = botItemHostWaitingAsk(item)
  const over =
    item.status === 'done' ||
    item.status === 'canceled' ||
    (named !== null
      ? (parseBotItemEventId(named) ?? 0) > (parseBotItemEventId(draft.askId) ?? 0)
      : botItemQuestionPairing(item, events).questions.get(draft.askId)?.waiting === false)
  if (over) {
    dropDraft(itemKey)
  } else {
    // Still waiting, on a page open now: a list read asked before this one can't drop it.
    draft.at = ++clock
  }
}

/** Drops the cards of the bot's items a list read shows closed. The list holds no waiting ask, so
 *  an open item's card stays for its page's read to judge; a card saved or shown waiting after the
 *  read was asked (`askedAt`, from `botItemAskCardDraftsClock`) stays, as the item may have reopened. */
export function retireClosedBotItemAskCardDrafts(
  hostKey: string,
  botId: string,
  items: readonly Pick<BotItem, 'uid' | 'status'>[],
  askedAt: number
): void {
  const bot = botCardsKey(hostKey, botId)
  const cards = drafts.get(bot)
  if (!cards) {
    return
  }
  for (const item of items) {
    if (item.status !== 'done' && item.status !== 'canceled') {
      continue
    }
    const draft = cards.get(item.uid)
    if (draft && draft.at <= askedAt) {
      cards.delete(item.uid)
      if (cards.size === 0) {
        drafts.delete(bot)
        return
      }
    }
  }
}
