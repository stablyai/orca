// What a host's restart-resume surface offers: teardown's offer recording, the offer list and its
// actions, and Continue on a cut reply.

import type { AgentSessionResumeTrigger } from '../../../shared/agent-session-resume-marker'
import type { createInterruptedContinuation } from './structured-agent-session-interrupted-continuation'
import type { StructuredAgentSessionContinuationOutcome } from './structured-agent-session-restart-continuation'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-restart-resume-runner'
import type {
  StructuredAgentSessionRestartAudience,
  StructuredAgentSessionResumeCandidate,
  StructuredAgentSessionResumeFailure
} from './structured-agent-session-restart-resume-set'

export type StructuredAgentSessionRestartResume = {
  /** Teardown: begin, then per session a snapshot right before its child stops and a confirmation
   *  once the stop is proven, then one write of the confirmed offers. */
  beginTeardown: (trigger: AgentSessionResumeTrigger) => void
  captureBeforeStop: (sessionId: string) => void
  confirmStopped: (sessionId: string) => void
  recordMarkers: () => Promise<void>
  list: (
    audience?: StructuredAgentSessionRestartAudience
  ) => Promise<StructuredAgentSessionResumeCandidate[]>
  /** Offers already acted on whose agent did not carry on. Read-only; nothing here is spent. */
  listFailures: (
    audience?: StructuredAgentSessionRestartAudience
  ) => Promise<StructuredAgentSessionResumeFailure[]>
  /** Unnamed, continues every offer the audience sees; named, only those of them. */
  continueAfterRestart: (
    sessionIds: readonly string[] | undefined,
    owner: string,
    audience?: StructuredAgentSessionRestartAudience
  ) => Promise<{
    resumed: StructuredAgentSessionResumeOutcome[]
    continued: StructuredAgentSessionContinuationOutcome[]
    sessions?: StructuredAgentSessionResumeCandidate[]
    failed?: StructuredAgentSessionResumeFailure[]
  }>
  /** Named sessions forget their offer or failure; unnamed, every record this host lists goes (a
   *  newer Orca's stay). An audience limits either to the agents it sees. */
  dismiss: (
    sessionIds?: readonly string[],
    audience?: StructuredAgentSessionRestartAudience
  ) => Promise<number>
  /** The chat's agent proved a start: its offer ends unless the start is a resume's own. */
  onAgentStarted: (sessionId: string) => void
  /** Continue on a reply an Orca stop cut off, offer or not; the send itself retires any offer. */
  continueInterrupted: ReturnType<typeof createInterruptedContinuation>
}
