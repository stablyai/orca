import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { WorktreeTerminalStopSnapshot } from '../../terminal/stop/worktree-terminal-stop-options'
import type { PtyProcessInfo } from '../../../providers/pty-process-info'
import type { PtyRegistration } from '../../../memory/pty-registry'
import type {
  StructuredSessionsForWorktree,
  StructuredWorktreeSweepRuntime
} from './structured-session-worktree-teardown'

export type WorktreeTeardownRuntime = StructuredWorktreeSweepRuntime &
  Pick<OrcaRuntimeService, 'stopTerminalsForWorktree' | 'getPtyLivenessVerdict'> &
  Partial<
    Pick<
      OrcaRuntimeService,
      | 'captureWorktreeTerminalStops'
      | 'onPtyExit'
      | 'waitForPtyExitRetirement'
      | 'subscribeToPtyExit'
    >
  >

export type WorktreePtyStopOutcome = {
  incarnationId?: string
  attempted: boolean
  confirmed: boolean
  conflict: boolean
  allowAbsenceProof?: boolean
  exitCaptured?: boolean
  retirement?: Promise<boolean>
  retirementResult?: boolean
}

export type WorktreeTeardownSnapshot = {
  ptyOutcomes?: Map<string, WorktreePtyStopOutcome>
  runtime: WorktreeTerminalStopSnapshot
  provider: readonly PtyProcessInfo[]
  registry: readonly PtyRegistration[]
  structured: StructuredSessionsForWorktree
}

export type WorktreeTeardownDeps = {
  runtime?: WorktreeTeardownRuntime
  /** Authoritative id for callers whose selector no longer resolves (orphaned workspace). */
  resolvedWorktreeId?: string
  /** SSH connection owning `resolvedWorktreeId`; prevents same-id cross-host graph matches. */
  resolvedConnectionId?: string | null
  /** Runtime environment owning a mirrored `resolvedWorktreeId`. */
  resolvedRuntimeEnvironmentId?: string
  localProvider: IPtyProvider | null
  snapshot?: WorktreeTeardownSnapshot
  onPtyStopped?: (ptyId: string) => void
  timeoutMs?: number
  requirePhysicalStop?: boolean
  /** Explicit Force Delete only: warn instead of throwing when a stop stays unproven (#11960). */
  allowUnverifiedStop?: boolean
  includeProviderInventory?: boolean
  includeLocalRegistry?: boolean
  /** Close structured sessions for destructive folder removals even without PTY proof. This is separate from requirePhysicalStop; reconciliation sets neither and must never close sessions. */
  closeStructuredSessions?: boolean
}

export type WorktreeTeardownResult = {
  runtimeStopped: number
  providerStopped: number
  registryStopped: number
  /** Structured agent sessions this teardown closed; absent when it closed none. */
  structuredStopped?: number
  /** Best-effort forgetting does not establish this proof. */
  structuredStopConfirmed?: boolean
}
