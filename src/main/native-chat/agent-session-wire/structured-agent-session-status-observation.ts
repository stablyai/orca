import type { StructuredAgentSessionProjectedStatus } from '../../../shared/structured-agent-session-projection'

/** Host-only request identity; it never enters a status or wire frame. */
export type StructuredAgentSessionStatusObserverOptions = {
  replay: boolean
  firstInputSubmissionKey?: string | null
  /** The status this summary replaces, so an observer can act on a transition alone. */
  previousStatus?: StructuredAgentSessionProjectedStatus | null
}
