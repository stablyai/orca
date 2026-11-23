import type { StructuredAgentSessionAttachContext } from '../acquisition/structured-agent-session-attach-context'
import { startStructuredAgentSessionAgentForOperation } from './structured-agent-session-agent-start'

/** Reattaches the agent the terminal host kept running for this chat while Orca was closed. */
export async function rebindKeptStructuredAgentSessionAgent(
  open: (sessionId: string) => Promise<unknown>,
  context: StructuredAgentSessionAttachContext,
  sessionId: string
): Promise<void> {
  await open(sessionId)
  const outcome = await startStructuredAgentSessionAgentForOperation(context, sessionId)
  if (!outcome.ok) {
    context.deps.logger.warn('reattaching a kept chat agent failed', {
      scope: 'relay-rebind',
      sessionId,
      code: outcome.refusal.code
    })
  }
}
