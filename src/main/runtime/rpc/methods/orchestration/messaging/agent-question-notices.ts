/** The notice writer for every question a taker holds: bot questions tell their asking agent, and
 *  worker asks tell their worker. */

import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { QuestionNoticeWriter } from '../../../../orchestration/mailbox/questions/question-reconcile'
import type { ChatStateReader } from '../../../../../native-chat/agent-session-wire/observations/chat-turn-running'
import { botQuestionNotices } from './bot-question-notices'
import { workerAskNotices } from './worker-ask-notices'

export async function agentQuestionNotices(
  runtime: OrcaRuntimeService,
  taker: string,
  messageIds: readonly string[],
  readChat?: ChatStateReader
): Promise<QuestionNoticeWriter> {
  const db = runtime.getOrchestrationDb()
  const botIds = db.db
    .prepare(
      `SELECT message_id FROM bot_requests WHERE message_id IN (${messageIds.map(() => '?').join(',')})`
    )
    .all(...messageIds)
    .flatMap(({ message_id }) => (typeof message_id === 'string' ? [message_id] : []))
  // A taker holding only worker asks skips the bot wording, which reads its chat.
  const bot = botIds.length > 0 ? await botQuestionNotices(runtime, taker, botIds, readChat) : null
  const worker = workerAskNotices(runtime, taker)
  return (notice) => (notice.kind === 'bot' ? (bot?.(notice) ?? 'unverified') : worker(notice))
}
