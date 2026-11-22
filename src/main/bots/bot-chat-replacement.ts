// Closing the Chat a bot's `/new` or agent change replaces. Once it is proven stopped it will never
// read for its Runs again, so they stop naming it and a later worker ask there is told at once.
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  closeStructuredAgentSessionChild,
  type StructuredAgentSessionCloseOutcome
} from '../runtime/agent-session/lifecycle/structured-agent-session-close'
import { retireChatRuns } from '../runtime/orchestration/db/runs/retired-chat-runs'
import { dropUnreadBotRequests } from '../runtime/rpc/methods/orchestration/messaging/bot-request-outcome'

type Closed = Pick<StructuredAgentSessionCloseOutcome, 'stopped' | 'reason'>

export async function closeReplacedBotChat(
  runtime: OrcaRuntimeService,
  sessionId: string,
  close: (
    sessionId: string,
    options: { runtime: OrcaRuntimeService }
  ) => Promise<Closed> = closeStructuredAgentSessionChild
): Promise<Closed> {
  const closed = await close(sessionId, { runtime })
  if (closed.stopped) {
    retireChatRuns(runtime, sessionId)
  }
  return closed
}

/** `/new` and an agent change alike: nothing reads the replaced Chat's unread mail again. */
export async function dropReplacedChatMail(
  runtime: OrcaRuntimeService,
  botId: string,
  replaced: string | null
): Promise<void> {
  if (replaced) {
    await dropUnreadBotRequests(runtime, botId, 'new-chat', replaced)
  }
}
