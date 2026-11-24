// Whom a bot conversation with no acts-for record acts for, read from its first message.
import type { BotRequestAsker } from '../../../../../../shared/bots/bot-acts-for'
import { firstMessageActsFor } from '../../../../../bots/bot-request-asker'
import type { JournalSqlReads } from '../../../../../native-chat/agent-session-journal/journal-sql-reads'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { botRequestRecord } from './bot-request-record'

/** Whom a conversation Orca has no record for acts for, by its first message; null before any.
 *  `reads` are its /clear root's: a cleared chat reads its root's. Reads only. */
export async function readFirstMessageActsFor(
  db: OrchestrationDb,
  reads: Promise<Pick<JournalSqlReads, 'promptItem'>>,
  workspaceId: string | null
): Promise<BotRequestAsker[] | null> {
  const firstPrompt = await (await reads).promptItem('first')
  return firstMessageActsFor(firstPrompt ? [firstPrompt] : [], {
    botRequestAskers: (messageId) => botRequestRecord(db, messageId)?.askers ?? null,
    conversationWorkspaceId: workspaceId
  })
}
