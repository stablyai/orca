// Where a new item's result goes back to. Only a job that came to the item's bot as a handoff owes a
// thread, issue or pull request its result: a question's answer and a status's follow-up go back to
// the bot that sent it. A link the add carries is context and never says whose job the item is.
import { BotItemError } from '../../../bots/bot-item-error'
import { uniqueBotItemLinks, type BotItemLinkInput } from '../../../bots/bot-items-input'
import { BOT_ITEM_LIMITS } from '../../../../shared/bots/bot-items'
import { parseItemLink } from './bots-items-write-support'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { botRequestRecord } from './orchestration/messaging/bot-request-record'

/** `--request`: the place of the handoff the item is the job of, or none for a question or status
 *  (or a handoff that started nowhere with a link); refused unless it is a request to `botId`.
 *  Without it: the place all the adding turn's work came from (its consensus), if any. */
export function itemStartedIn(
  db: Pick<OrchestrationDb, 'getBotRequest'>,
  botId: string,
  request: string | undefined,
  turnPlace: { url?: string } | null
): string | null {
  if (request === undefined) {
    return turnPlace?.url ?? null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: botRequestRecord reads only getBotRequest.
  const record = botRequestRecord(db as OrchestrationDb, request)
  if (!record || record.toBotId !== botId) {
    throw new BotItemError(
      'invalid_argument',
      `${request} is not a request to this bot; --request takes the message id of a request it was sent.`
    )
  }
  return record.purpose === 'handoff' ? (record.originPlace?.url ?? null) : null
}

/** The add's own links, each once, plus the origin's unless one names the same page (a Slack link
 *  may add `?thread_ts=`). Deduplicated first, so a repeated link never takes the origin's room. */
export function itemLinksWithOrigin(
  typed: readonly BotItemLinkInput[],
  startedIn: string | null
): BotItemLinkInput[] {
  const unique = uniqueBotItemLinks(typed)
  if (!startedIn) {
    return unique
  }
  const origin = parseItemLink(startedIn)
  const key = (link: BotItemLinkInput) =>
    `${link.kind}:${link.kind === 'url' ? link.ref.split(/[?#]/)[0] : link.ref}`
  // An add already at the link limit keeps its own links: the origin is guidance, never a refusal.
  const full = unique.length >= BOT_ITEM_LIMITS.links
  return full || unique.some((link) => key(link) === key(origin)) ? unique : [...unique, origin]
}
