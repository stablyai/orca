// A status to a bot that is waiting on the sender is refused: the answer has to go as a reply,
// which wakes it, never as a note it may not read. An ask waits for 24 hours after it was sent,
// whatever was replied, unless the item it is about is closed.
import { canonicalOrcaSessionId } from '../../../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import { isOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address'
import { BOT_ITEM_MAIL_ID_PREFIX } from '../../../../../../shared/bots/bot-item-note-runs'
import { isOpenBotItemStatus } from '../../../../../../shared/bots/bot-items'
import type { BotItemsRemote } from '../../../../../bots/bot-items-ops'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

/** How long an ask waits for its result after it is sent; the asked bot often accepts at once and
 *  reports hours later. */
export const BOT_ASK_WAIT_HOURS = 24

const CANDIDATES = 10

type Ask = { id: string; purpose: string; record: string }

/** `bot item add --for` mail is `msg_item_` and the item's uid without its dashes. */
export function itemUidOfRequest(messageId: string | null): string | null {
  const hex = messageId?.startsWith(BOT_ITEM_MAIL_ID_PREFIX)
    ? messageId.slice(BOT_ITEM_MAIL_ID_PREFIX.length)
    : ''
  return /^[0-9a-f]{32}$/.test(hex)
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    : null
}

/** The asks `askerBotId` sent to this chat in the wait window, newest first. A chat that
 *  coordinates a Run has its mail stored as `run:<id>`, so its own address is found through that. */
function recentAsks(
  db: OrchestrationDb,
  askerBotId: string,
  askedBotId: string,
  sessionId: string
): Ask[] {
  const root = isOrcaSessionId(sessionId) ? canonicalOrcaSessionId(sessionId) : sessionId
  const chats = JSON.stringify([...new Set([sessionId, root])].map((id) => `orca_session_id:${id}`))
  return db.db
    .prepare(
      `SELECT br.message_id AS id, br.purpose AS purpose, br.record AS record
         FROM bot_requests br JOIN messages m ON m.id = br.message_id
        WHERE br.from_bot_id = ? AND br.to_bot_id = ? AND br.purpose IN ('question', 'handoff')
          AND br.created_at >= datetime('now', ?)
          AND (m.to_handle IN (SELECT value FROM json_each(?))
            OR (m.to_handle = 'run:' || m.run_id AND EXISTS (
              SELECT 1 FROM run_coordinator_handles h
               WHERE h.run_id = m.run_id AND h.terminal_handle IN (SELECT value FROM json_each(?)))))
        ORDER BY m.sequence DESC
        LIMIT ?`
    )
    .all(askerBotId, askedBotId, `-${BOT_ASK_WAIT_HOURS} hours`, chats, chats, CANDIDATES)
    .flatMap((row) =>
      typeof row.id === 'string' &&
      typeof row.purpose === 'string' &&
      typeof row.record === 'string'
        ? [{ id: row.id, purpose: row.purpose, record: row.record }]
        : []
    )
}

/** The item an ask is about: the one `bot item add --for` made, or the one `send --item` named. */
async function askItemClosed(store: BotItemsRemote, ask: Ask): Promise<boolean> {
  const uid = itemUidOfRequest(ask.id)
  let number: unknown
  try {
    const parsed: unknown = JSON.parse(ask.record)
    number = parsed && typeof parsed === 'object' && 'item' in parsed ? parsed.item : undefined
  } catch {
    number = undefined
  }
  const item = uid
    ? await store.get(uid)
    : typeof number === 'string' && /^\d+$/.test(number)
      ? await store.byNumber(Number(number))
      : null
  return item ? !isOpenBotItemStatus(item.status) : false
}

/** Refuses a status from the asked bot while `askerName`'s ask to this chat still waits. */
export async function assertNoWaitingAsk(
  db: OrchestrationDb,
  store: BotItemsRemote,
  asker: { id: string; name: string },
  askedBotId: string,
  sessionId: string
): Promise<void> {
  for (const ask of recentAsks(db, asker.id, askedBotId, sessionId)) {
    if (await askItemClosed(store, ask)) {
      continue
    }
    throw new OrchestrationError(
      'bot_ask_waiting',
      `${asker.name} is waiting on your answer to its ${ask.purpose} ${ask.id}, so nothing was sent. Reply with \`orca orchestration reply --id ${ask.id} --body "..."\` if this answers ${asker.name}; if it's only FYI for ${asker.name}, there's nothing to send.`
    )
  }
}
