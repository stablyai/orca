import type { StructuredAgentSessionAttachContext } from '../acquisition/structured-agent-session-attach-context'
import { startStructuredAgentSessionAgentForOperation } from './structured-agent-session-agent-start'
import { waitForStructuredAgentSessionStart } from './structured-agent-session-start-readiness'

// Leaves the call time to connect before the renderer's 45 s connect deadline.
const VOICE_WAKE_BUDGET_MS = 30_000

/** Voice talks to a live agent, so a chat that idle stop put to rest starts it the way an operation
 *  does: one start however many callers wait, resumed on the chat's own thread, answered once the
 *  agent is ready. The caller then asks the adapter, which still refuses a chat that did not come
 *  back. */
export async function wakeStructuredAgentSessionForVoice(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  budgetMs = VOICE_WAKE_BUDGET_MS
): Promise<void> {
  const agent = context.deps.store.getConversation(sessionId)?.provider
  if (!agent || !context.deps.agents.registration(agent)?.adapter.startVoiceConversation) {
    return
  }
  await waitForStructuredAgentSessionStart(
    startStructuredAgentSessionAgentForOperation(context, sessionId).then(() => 'ready' as const),
    budgetMs
  )
}
