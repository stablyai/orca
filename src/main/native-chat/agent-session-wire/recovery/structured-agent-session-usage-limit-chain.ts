import { createHash } from 'node:crypto'
import type { JournalSqlDatabase } from '../../agent-session-journal/database/journal-sql-database'
import { journalSqlReads } from '../../agent-session-journal/journal-sql-reads'
import type { NativeChatUsageLimitCut } from '../../../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'

/** Automatic continues a chain may spend before Orca leaves the chat to the person. */
export const USAGE_LIMIT_CONTINUE_CHAIN_LIMIT = 5

export const usageLimitContinueIdentity = (
  cut: Pick<NativeChatUsageLimitCut, 'turnItemId' | 'resetsAt'>
): string => JSON.stringify([cut.turnItemId, cut.resetsAt])

/** Names the cut an automatic continue answers; its message id carries this, so the journal keeps the chain. */
export const usageLimitContinueTag = (
  cut: Pick<NativeChatUsageLimitCut, 'turnItemId' | 'resetsAt'>
) => createHash('sha256').update(usageLimitContinueIdentity(cut)).digest('hex').slice(0, 16)

/** `<13-digit time>-<tag><16 random hex>`, as the sweep writes it. */
export function usageLimitContinueMessageId(at: number, tag: string, random: string): string {
  return `${Math.trunc(at).toString().padStart(13, '0')}-${tag}${random}`
}

/** A cut as the host's sweep reads it: with the chain that led to it and the runtime fence that
 *  ran its turn, which names the account it hit. */
export type HostUsageLimitCut = NativeChatUsageLimitCut & { chain: number; fence?: number }

/** Reads a chat's saved conversation without opening it, as main does for unopened chats. */
export async function readSavedUsageLimitCut(
  database: JournalSqlDatabase,
  id: string
): Promise<HostUsageLimitCut | null> {
  const epoch = await database.ensureSessionEpoch(id)
  return epoch === null ? null : journalSqlReads(database.readers, id).usageLimitCut()
}
