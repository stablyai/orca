// Closing the Chat a bot's `/new` or agent change replaces. Once it is proven stopped it will never
// read for its Runs again, so they stop naming it and a later worker ask there is told at once.
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  closeStructuredAgentSessionChild,
  type StructuredAgentSessionCloseOutcome
} from '../runtime/agent-session/lifecycle/structured-agent-session-close'
import { retireReplacedChat } from '../runtime/orchestration/db/runs/retired-chat-runs'

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
    retireReplacedChat(runtime, sessionId)
  }
  return closed
}
