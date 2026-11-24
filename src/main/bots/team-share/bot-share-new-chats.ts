// Which chat a teammate's "new chat" opened, by the id their device minted for it, so a live start, a
// held message and its redelivery naming that id all land in that one chat, whichever comes first.
// Keyed by the teammate's own account on the bot, so no one reaches another's chat by its id. Kept in
// the mutation receipt ledger as other durable request ids are.
import { z } from 'zod'
import type { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import { hashCanonical } from '../../runtime/rpc/orchestration/mutations/orchestration-mutation-receipt'

const NEW_CHAT_FINGERPRINT = 'bot-share:new-chat'
const Opened = z.object({ sessionId: z.string().min(1) })

export type BotShareNewChatKey = { botId: string; accountId: string; newChatId: string }

// Starts running in this process, so a live start and a held message at once open one chat.
const starting = new Map<string, Promise<string>>()

/**
 * The chat recorded for the key, else `start`'s, then recorded. A start left unrecorded by a crash
 * runs again; it reopens that same empty chat (a teammate's new chat reuses their own empty chat).
 */
export async function openBotShareNewChat(
  db: OrchestrationDb,
  key: BotShareNewChatKey,
  start: () => Promise<string>
): Promise<string> {
  const parts = [key.botId, key.accountId, key.newChatId]
  const identity = {
    callerFingerprint: NEW_CHAT_FINGERPRINT,
    requestId: JSON.stringify(parts),
    method: 'bots.session.start',
    payloadHash: hashCanonical(parts)
  }
  const running = starting.get(identity.requestId)
  if (running) {
    return await running
  }
  const begun = db.beginMutationReceipt(identity)
  if (begun.disposition === 'completed') {
    const opened = Opened.safeParse(JSON.parse(begun.row.receipt ?? 'null'))
    if (opened.success) {
      return opened.data.sessionId
    }
  }
  const run = (async () => {
    let sessionId: string
    try {
      sessionId = await start()
    } catch (error) {
      db.discardPendingMutationReceipt(identity.callerFingerprint, identity.requestId)
      throw error
    }
    db.completeMutationReceipt({ ...identity, receipt: JSON.stringify({ sessionId }) })
    return sessionId
  })()
  starting.set(identity.requestId, run)
  try {
    return await run
  } finally {
    starting.delete(identity.requestId)
  }
}
