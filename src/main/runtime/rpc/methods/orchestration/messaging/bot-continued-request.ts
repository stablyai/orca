// Which earlier request a bot's running turn continues, so its items and the requests it sends keep
// that request's key and start instead of starting their own. Read only from records Orca wrote
// (bot-turn-continuation.ts), never from a message's words: "go on" in a chat starts a new request.
//   1. A turn only Orca's item mail (and workers' reports) woke since the turn it was read from (the
//      owner's answer or comment on an item) continues the request every item it names was made for.
//   2. A turn Orca's own continue after a restart or a usage limit opened continues the turn it
//      resumes; with none readable it starts its own, as Orca's, with no one's words.
//   3. A group member's turn continues the room line that started its request, whichever member
//      runs it and however it got there (its own turn on the post, an @mention, a peer's request).
//   4. Anything else starts its own (the message or request that opened it; a request steered in
//      later changes neither).
// A prose question the bot asked, answered by the owner's next message, has no recorded link, so
// that answer starts a new request; `bot item add --from-item` states such a link explicitly.
import { isBotGroupMemberSession } from '../../../../../../shared/bots/bot-group'
import { BOT_ITEM_MAIL_SENDER } from '../../../../../../shared/bots/bot-item-note-runs'
import type { BotItemsRemote } from '../../../../../bots/bot-items-ops'
import type { BotActingTurn } from '../../../../../bots/bot-request-asker'
import type { BotGroupStore } from '../../../../../bots/bot-group-store'
import { runtimeBotGroups } from '../../../../../bots/bot-group-runtime'
import { groupTurnRequest } from '../../../../../bots/bot-group-turn-request'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { BotItemOrigin } from '../../../../../../shared/bots/bot-items'
import {
  botRequestChain,
  botTurnRequestOrigin,
  type BotRequestJoins,
  type BotTurnContinues
} from './bot-request-chain'

/** The records the rules read: Orca's mail and requests, items' origins, and the caller's room. */
export type ContinuedRequestStores = {
  db: OrchestrationDb
  items: Pick<BotItemsRemote, 'originsOf'>
  /** Null for a chat that is no group room's member. */
  groups: BotGroupStore | null
}

/** Built when read, inside its guard. The items store opens only for a turn item mail woke, whose
 *  items file already exists; a send from any other turn never opens it (or starts its
 *  usage-limit watch). */
export function continuedRequestStores(
  runtime: OrcaRuntimeService,
  sessionId: string
): () => Omit<ContinuedRequestStores, 'db'> {
  return () => ({
    items: { originsOf: (uids) => runtime.botItems.store().originsOf(uids) },
    groups: isBotGroupMemberSession(sessionId) ? runtimeBotGroups(runtime).store : null
  })
}

/** The items an item mail names, from the payload Orca wrote for it (bots-items-mail.ts). */
function itemMailUids(payload: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(payload ?? 'null')
    const items =
      typeof parsed === 'object' && parsed !== null && 'botItems' in parsed ? parsed.botItems : null
    return Array.isArray(items)
      ? items.flatMap((item: unknown) =>
          typeof item === 'object' && item !== null && 'uid' in item && typeof item.uid === 'string'
            ? [item.uid]
            : []
        )
      : []
  } catch {
    return []
  }
}

/** The request every item the mail names was made for; null when it names none, one has no origin
 *  (made before Orca recorded one), or they differ. */
async function itemMailRequest(
  stores: ContinuedRequestStores,
  mailIds: readonly string[]
): Promise<BotTurnContinues | null> {
  const uids = [
    ...new Set(
      mailIds.flatMap((id) => {
        const mail = stores.db.getMessageById(id)
        // Only Orca writes as this sender (message-orca-provenance.ts), so the payload is its own.
        return mail?.from_handle === BOT_ITEM_MAIL_SENDER ? itemMailUids(mail.payload) : []
      })
    )
  ]
  const origins = uids.length > 0 ? await stores.items.originsOf(uids) : {}
  const [first, ...rest] = uids.map((uid) => origins[uid])
  if (!first || rest.some((origin) => origin?.rootKey !== first.rootKey)) {
    return null
  }
  const { rootKey, ...start } = first
  return { rootKey, start }
}

/** What the running turn continues, by the rules above; null when it starts its own. */
async function continuedRequest(
  stores: ContinuedRequestStores,
  sessionId: string,
  turn: BotActingTurn
): Promise<BotTurnContinues | null> {
  const fromItems = turn.itemMailIds ? await itemMailRequest(stores, turn.itemMailIds) : null
  if (fromItems) {
    return fromItems
  }
  if (turn.resumes) {
    const continues = await continuedRequest(stores, sessionId, turn.resumes)
    const { rootKey, start } = botRequestChain(stores.db, sessionId, turn.resumes, { continues })
    return { ...(rootKey ? { rootKey } : {}), start }
  }
  if (turn.resumes === null) {
    // Orca's own continue with no turn to resume: Orca's, with no one's words.
    return { start: { kind: 'automation', at: turn.openedAt ?? null, request: null } }
  }
  return stores.groups ? groupTurnRequest(stores.groups, stores.db, sessionId, turn) : null
}

/** What a bot's running turn continues, which a send from it records. Never throws: a turn whose
 *  continuation can't be read starts its own, as before Orca read this. */
export async function readContinuedRequest(
  db: OrchestrationDb,
  stores: () => Omit<ContinuedRequestStores, 'db'>,
  sessionId: string,
  turn: BotActingTurn
): Promise<BotTurnContinues | null> {
  try {
    return await continuedRequest({ db, ...stores() }, sessionId, turn)
  } catch (error) {
    console.warn('[bots] could not read the request a turn continues', error)
    return null
  }
}

/** The request a bot's running turn acts on: what it continues, and the origin an item made in it
 *  records (the chain a send from it records). */
export async function readTurnRequest(
  db: OrchestrationDb,
  stores: () => Omit<ContinuedRequestStores, 'db'>,
  sessionId: string,
  turn: BotActingTurn,
  joins: Pick<BotRequestJoins, 'fromItemKey'> = {}
): Promise<{ continues: BotTurnContinues | null; origin: BotItemOrigin | null }> {
  const continues = await readContinuedRequest(db, stores, sessionId, turn)
  return { continues, origin: botTurnRequestOrigin(db, sessionId, turn, { ...joins, continues }) }
}
