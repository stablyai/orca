// Binds the restart-resume surface to the host's own capabilities.
//
// Its own file because the bindings carry real decisions — which caller key the continuation sends
// under, that the verdict comes from the settlement waiter rather than the send result, and where a
// failed journal note is reported — and those belong next to the collaborator that consumes them
// rather than buried in the host constructor.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionRestartResumeSurfaces } from './structured-agent-session-restart-resume-host'

/** The caller key the continuation sends under, so its writes are attributable to Orca itself. */
export const STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER =
  'trusted-local:restart-continuation'

/** Exactly the host members this binds. Structural, so the host satisfies it without declaring a
 *  dependency, and nothing outside this list is reachable from here. */
type RestartResumeHostBindings = {
  revealSession: (sessionId: string) => Promise<{ readable: boolean }>
  hold: (sessionId: string, holderId: string) => Promise<void>
  release: (sessionId: string, holderId: string) => void
  send: (
    caller: { callerKey: string },
    params: {
      envelope: AgentSessionMutationEnvelope
      body: AgentJournalMessageItem
      beforeRun?: () => void
    }
  ) => Promise<AgentSessionMutationResult<AgentSessionSendResult>>
  /** The host's existing settlement waiter; a send returns while its dispatch is still pending. */
  waitForSendSettlement: (
    sessionId: string,
    clientMessageId: string
  ) => Promise<{ value: AgentSessionSendResult } | undefined>
}

export function structuredAgentSessionRestartResumeSurfaces(
  host: RestartResumeHostBindings,
  now: () => number
): StructuredAgentSessionRestartResumeSurfaces {
  return {
    revealSession: host.revealSession,
    hold: host.hold,
    release: host.release,
    send: (params) =>
      host.send({ callerKey: STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER }, params),
    awaitSendSettlement: host.waitForSendSettlement,
    onNoteFailed: () =>
      console.warn('[structured-agent-session] restart continuation attribution failed'),
    now
  }
}
