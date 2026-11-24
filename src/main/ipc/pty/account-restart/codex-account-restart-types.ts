import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type {
  CodexAccountRestartNotStartedReason,
  CodexAccountRestartStopRequest
} from '../../../../shared/agent-accounts/codex/codex-account-restart-stop'

/** The conversation the stopped process was writing, captured before the stop. */
export type CodexRestartProvenance = {
  threadId: string
  transcriptPath: string
}

export type CodexRestartOccupant = {
  ptyId: string
  incarnationId: string
  provenance: CodexRestartProvenance
}

/**
 * `ended` (root and every captured writer gone) is the only writer proof; `ended-unproven` stopped
 * the root but could not verify its descendants. `refused` and `service-outdated` sent no signal.
 */
export type CodexRestartStopOutcome =
  | 'ended'
  | 'ended-unproven'
  | 'refused'
  | 'service-outdated'
  | 'unknown'

export type CodexAccountRestartStopDeps = {
  /** Re-derives the pane's eligible occupant from host facts, or the reason it has none. */
  resolveOccupant: (
    request: CodexAccountRestartStopRequest
  ) => CodexRestartOccupant | CodexAccountRestartNotStartedReason
  /**
   * Dispatches the exact-incarnation fenced stop. Call `authorize` after the last wait main
   * controls and immediately before the request; when it says no, send nothing.
   */
  stop: (
    occupant: CodexRestartOccupant,
    authorize: () => boolean
  ) => Promise<CodexRestartStopOutcome | 'not-authorized'>
}

export type CodexRestartExitObservation = 'stream' | 'host-loss' | 'fenced-receipt' | 'attach-miss'
/** `restart`: the first logical exit of a restart-stopped incarnation; `duplicate`: drop it. */
/** `restart-renderer-only`: runtime already took this exit from an attach miss; only the renderer is owed it. */
export type CodexRestartExitClassification =
  | 'ordinary'
  | 'restart'
  | 'restart-renderer-only'
  | 'duplicate'

export type CodexRestartResumeDecision =
  | { kind: 'none' }
  | { kind: 'pinned' }
  | {
      kind: 'selected'
      providerSession: AgentProviderSessionMetadata
      /** Puts the intent back for the next resume when this launch fails before commit. */
      unspend: () => void
    }

export function isValidRestartRequest(
  r: Partial<CodexAccountRestartStopRequest> | null | undefined
): r is CodexAccountRestartStopRequest {
  return Boolean(
    r &&
    typeof r.worktreeId === 'string' &&
    r.worktreeId &&
    typeof r.tabId === 'string' &&
    r.tabId &&
    typeof r.leafId === 'string' &&
    r.leafId &&
    typeof r.ptyId === 'string' &&
    r.ptyId &&
    typeof r.opId === 'string' &&
    r.opId
  )
}

export function isSameRestartOccupant(a: CodexRestartOccupant, b: CodexRestartOccupant): boolean {
  return (
    a.ptyId === b.ptyId &&
    a.incarnationId === b.incarnationId &&
    a.provenance.threadId === b.provenance.threadId &&
    a.provenance.transcriptPath === b.provenance.transcriptPath
  )
}
