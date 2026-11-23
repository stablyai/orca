// Whom a bot conversation with no acts-for record acts for, read from its first message.
import type { BotRequestAsker } from '../../../../../../shared/bots/bot-acts-for'
import { requireStructuredHost } from '../../../../../bots/bot-chat-session'
import { firstMessageActsFor } from '../../../../../bots/bot-request-asker'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { botRequestRecord } from './bot-request-record'

/** Whom a conversation Orca has no record for acts for, by its first message; null before any.
 *  `root` is the conversation's /clear root: a cleared chat reads its root's. Reads only. */
export async function readFirstMessageActsFor(
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>,
  db: OrchestrationDb,
  root: string,
  workspaceId: string | null
): Promise<BotRequestAsker[] | null> {
  const host = await requireStructuredHost(runtime)
  const firstPrompt = await (await host.journalReads(root)).promptItem('first')
  return firstMessageActsFor(firstPrompt ? [firstPrompt] : [], {
    botRequestAskers: (messageId) => botRequestRecord(db, messageId)?.askers ?? null,
    conversationWorkspaceId: workspaceId
  })
}
