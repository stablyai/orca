import type { AgentSessionOrcaStopCause } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-orca-stop'
import type { AgentSessionResumeTrigger } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import type { createInterruptedContinuation } from './structured-agent-session-interrupted-continuation'
import type { StructuredAgentSessionContinuationOutcome } from './structured-agent-session-restart-continuation'
import type { StructuredAgentSessionResumeOutcome } from './structured-agent-session-restart-resume-runner'
import type {
  StructuredAgentSessionRestartAudience,
  StructuredAgentSessionResumeCandidate,
  StructuredAgentSessionResumeFailure
} from './structured-agent-session-restart-resume-set'

export type StructuredAgentSessionRestartCut = {
  cause: AgentSessionOrcaStopCause
  turnId: string
  /** The turn was asking its person: the prompt's item when known. */
  waitingOnPerson?: true
}

export type RestartContinuationOptions = {
  automatic?: boolean
  /** The chats this action reserved, before any agent starts; called once, empty when it took none. */
  onReserved?: (rows: StructuredAgentSessionResumeCandidate[]) => void
}

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
  /** Record the offers a crash left in these chats, read from what this start's settlement wrote. */
  adoptCrashCuts: (
    cuts: readonly { sessionId: string; crashedRuntime: string }[],
    settledSince: number
  ) => Promise<number>
  /** Ends this launch's automatic turn: offers recorded by then that still wait are left to a person. */
  passOverAutomatic: (recordedBy: number) => Promise<void>
  /** The cut a restart left in this chat: its offer, else the journal's own stop row. */
  cutOf: (sessionId: string) => Promise<StructuredAgentSessionRestartCut | null>
  /** Unnamed actions continue visible offers; named actions may also retry selected failures.
   *  `automatic` continues only what the capsule's ledger allows (see automaticallyContinuable). */
  continueAfterRestart: (
    sessionIds: readonly string[] | undefined,
    owner: string,
    audience?: StructuredAgentSessionRestartAudience,
    options?: RestartContinuationOptions
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
