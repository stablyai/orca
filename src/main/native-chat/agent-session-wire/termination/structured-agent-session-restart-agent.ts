// Stop a chat's agent on request so its next start reads the current account, login and settings.
// The automatic retire-on-send skips agents that still own background work; the person may not wait.

import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import type { AgentSessionRestartAgentResult } from '../../../../shared/agent-session/agent-session-restart-agent'
import { heldStructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-host-current-work'
import { stopStructuredAgentSessionAgentUnderSerialize } from './structured-agent-session-host-lifetime'
import type { StructuredAgentSessionConversationLifetimeHost } from './structured-agent-session-conversation-lifetime-host'

export type StructuredAgentSessionRestartAgentHost = Pick<
  StructuredAgentSessionConversationLifetimeHost,
  'context' | 'sessions' | 'serialize' | 'deliveryActive' | 'childWorkOpen'
> & {
  hasOpenDispatch: (sessionId: string) => boolean
  providerHoldsDispatch: (sessionId: string) => boolean
}

/** A turn, prompt or queued send is never cut; background work is stopped only when forced. */
export function restartStructuredAgentSessionAgent(
  host: StructuredAgentSessionRestartAgentHost,
  sessionId: string,
  force: boolean
): Promise<AgentSessionRestartAgentResult> {
  return host.serialize(sessionId, async () => {
    const session = host.sessions.get(sessionId)
    const child = session?.child
    if (!session || !child || child.close) {
      return { restarted: false, reason: 'not-running' }
    }
    const context = host.context()
    const work = heldStructuredAgentSessionCurrentWork(
      context.deps.store,
      sessionId,
      session.journal,
      session
    )
    if (
      child.phase === 'starting' ||
      host.deliveryActive(sessionId) ||
      session.journal.inputOrder.recoverableSubmissions().some(isQueuedAgentJournalSubmission) ||
      work.activeTurnId() !== null ||
      work.hasActionablePrompt()
    ) {
      return { restarted: false, reason: 'busy' }
    }
    if (
      !force &&
      (host.childWorkOpen(sessionId) ||
        host.hasOpenDispatch(sessionId) ||
        host.providerHoldsDispatch(sessionId))
    ) {
      return { restarted: false, reason: 'background-work' }
    }
    // The same resting stop the retire-on-send uses, so the next send starts a fresh agent.
    await stopStructuredAgentSessionAgentUnderSerialize(context, sessionId, {
      cause: 'evict',
      resting: true
    })
    return { restarted: true }
  })
}
