// Whom a bot conversation with no acts-for record acts for, read from its first message.
import type { BotRequestAsker } from '../../../../../../shared/bots/bot-acts-for'
import { firstMessageActsFor } from '../../../../../bots/bot-request-asker'
import type { JournalSqlReads } from '../../../../../native-chat/agent-session-journal/journal-sql-reads'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { botRequestRecord, isPulledServerRequest } from './bot-request-record'
import {
  formatOrcaSessionAddress,
  type OrcaSessionId
} from '../../../../../../shared/agent-session/identity/orca-session-address'

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

/** Whether a chat was started for a request pulled from a paired server: its first message is that
 *  request, filed under the server's reverse conversation, and addressed to this very chat (`root`,
 *  its /clear root). Earlier versions kept such a chat's acts-for as the owner's; it acts for no
 *  one. A chat that merely received such a request later, or one a person opened, is not one. */
export async function isPulledRequestChat(
  db: OrchestrationDb,
  reads: Promise<Pick<JournalSqlReads, 'promptItem'>>,
  root: OrcaSessionId
): Promise<boolean> {
  const firstPrompt = await (await reads).promptItem('first')
  const mail =
    firstPrompt?.body.kind === 'message' ? firstPrompt.body.from?.orchestration : undefined
  if (mail?.message !== 'mail-notice') {
    return false
  }
  const address = formatOrcaSessionAddress(root)
  return mail.messages.some(
    ({ messageId }) =>
      isPulledServerRequest(db, messageId) && db.getMessageById(messageId)?.to_handle === address
  )
}
