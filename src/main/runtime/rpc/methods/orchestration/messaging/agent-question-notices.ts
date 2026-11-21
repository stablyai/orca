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
  const bot = await botQuestionNotices(runtime, taker, messageIds, readChat)
  const worker = workerAskNotices(runtime, taker)
  return (notice) => (notice.kind === 'bot' ? bot(notice) : worker(notice))
}
