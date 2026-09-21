import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import { attachStructuredAgentSessionInTransition } from './structured-agent-session-attach-orchestration'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { resumeStructuredAgentSessionForHold } from './structured-agent-session-host-lifetime'

/** Establishes an actual provider owner inside the caller's keyed session transition. */
export async function ensureStructuredAgentSessionReady(
  context: StructuredAgentSessionAttachContext,
  sessionId: string
): Promise<void> {
  const current = context.sessions.get(sessionId)
  if (!current) {
    throw new Error(AGENT_SESSION_NOT_ATTACHED.code)
  }
  if (current.pendingCloseCompletion) {
    await current.pendingCloseCompletion
  }
  if (current.hasProviderChild && (context.deps.adapter.isSessionReady?.(sessionId) ?? true)) {
    return
  }
  await resumeStructuredAgentSessionForHold(context, sessionId, (params) =>
    attachStructuredAgentSessionInTransition(context, 'trusted-local:send-readiness', params)
  )
  const resumed = context.sessions.get(sessionId)
  if (
    !resumed?.hasProviderChild ||
    (context.deps.adapter.isSessionReady?.(sessionId) ?? true) === false
  ) {
    throw new Error('agent_session_ownership_unknown')
  }
}
