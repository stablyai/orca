// Where a bot's running turn's work started, read as cheaply as an optional answer allows: the newest
// turn by index alone, Orca's request records by id and the prompt's own run record. Nothing reads
// the chat's history, its automation runs or its conversation's earlier record.
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { BotWakingPlace } from '../../../../../bots/bot-request-asker'
import { readNewestBotActingTurn } from '../../../../../bots/bot-acting-turn-read'
import { requireStructuredHost } from '../../../../../bots/bot-chat-session'
import { chatPaneKey } from '../../../../../external-conversations/external-conversation-chat'
import { recordedAutomationPlace } from './bot-automation-place'
import { botRequestActsFor } from './bot-request-record'
import { workspaceOf } from './bot-recipient'

/** The thread, issue or pull request the running turn's work started in; null when none, or when
 *  only reading the whole chat could tell (thrown as `JournalWindowNotIndexed`). */
export async function readBotTurnOrigin(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  sessionId: string
): Promise<BotWakingPlace | null> {
  const key = runtime.getExternalConversationSeam()?.replyTarget(chatPaneKey(sessionId))?.key
  const host = await requireStructuredHost(runtime)
  const turn = await readNewestBotActingTurn(
    await host.journalReads(sessionId),
    {
      isBotRequest: (messageId) => db.getBotRequest(messageId) !== undefined,
      botRequestActsFor: (messageId) => botRequestActsFor(db, messageId),
      conversationActsFor: [],
      automationPlace: (run) => recordedAutomationPlace(run, key !== undefined),
      conversationWorkspaceId: key ? workspaceOf(key.externalId) : null
    },
    undefined,
    false
  )
  return turn.originPlace ?? null
}
