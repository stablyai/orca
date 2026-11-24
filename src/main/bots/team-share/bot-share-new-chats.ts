// Which chat a teammate's held "new chat" opened, by the id their device minted for it, so a
// redelivery and their later held messages for it land in that one chat. Kept in the mutation
// receipt ledger as other durable request ids are.
import { z } from 'zod'
import type { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import { hashCanonical } from '../../runtime/rpc/orchestration/mutations/orchestration-mutation-receipt'

const NEW_CHAT_FINGERPRINT = 'bot-share:new-chat'
const Opened = z.object({ sessionId: z.string().min(1) })

/**
 * The chat recorded for `newChatId` on the share, else `start`'s, then recorded. A start left
 * unrecorded by a crash runs again; it reopens that same empty chat (bots.session.start reuses the
 * teammate's own empty chat), so a new-chat id never opens two.
 */
export async function openBotShareNewChat(
  db: OrchestrationDb,
  key: { shareId: string; newChatId: string },
  start: () => Promise<string>
): Promise<string> {
  const identity = {
    callerFingerprint: NEW_CHAT_FINGERPRINT,
    requestId: JSON.stringify([key.shareId, key.newChatId]),
    method: 'bots.session.start',
    payloadHash: hashCanonical([key.shareId, key.newChatId])
  }
  const begun = db.beginMutationReceipt(identity)
  if (begun.disposition === 'completed') {
    const opened = Opened.safeParse(JSON.parse(begun.row.receipt ?? 'null'))
    if (opened.success) {
      return opened.data.sessionId
    }
  }
  let sessionId: string
  try {
    sessionId = await start()
  } catch (error) {
    db.discardPendingMutationReceipt(identity.callerFingerprint, identity.requestId)
    throw error
  }
  db.completeMutationReceipt({ ...identity, receipt: JSON.stringify({ sessionId }) })
  return sessionId
}
