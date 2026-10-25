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
  /** Snapshot before Stop, confirm proven exit, then persist confirmed offers together. */
  beginTeardown: (trigger: AgentSessionResumeTrigger) => void
  captureBeforeStop: (sessionId: string) => void
  confirmStopped: (sessionId: string) => void
  recordMarkers: () => Promise<void>
  list: (
    audience?: StructuredAgentSessionRestartAudience
  ) => Promise<StructuredAgentSessionResumeCandidate[]>
  listFailures: (
    audience?: StructuredAgentSessionRestartAudience
  ) => Promise<StructuredAgentSessionResumeFailure[]>
  /** Unnamed actions continue visible offers; named actions may also retry selected failures. */
  continueAfterRestart: (
    sessionIds: readonly string[] | undefined,
    owner: string,
    audience?: StructuredAgentSessionRestartAudience
  ) => Promise<{
    resumed: StructuredAgentSessionResumeOutcome[]
    continued: StructuredAgentSessionContinuationOutcome[]
    skipped?: string[]
    sessions?: StructuredAgentSessionResumeCandidate[]
    failed?: StructuredAgentSessionResumeFailure[]
  }>
  /** Dismiss visible records only; preserve newer-chat records this host never lists. */
  dismiss: (
    sessionIds?: readonly string[],
    audience?: StructuredAgentSessionRestartAudience
  ) => Promise<number>
  onAgentStarted: (sessionId: string) => void
  /** Continue a cut reply with or without an offer. */
  continueInterrupted: ReturnType<typeof createInterruptedContinuation>
}
