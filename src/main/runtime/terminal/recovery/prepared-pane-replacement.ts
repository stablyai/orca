import type { RetainedTerminalAttempt } from '../launch/retained-terminal-attempt'
import {
  settleRetainedTerminalOperationFailure,
  takeRetainedTerminalAttempt
} from '../launch/retained-terminal-operation'
import type { OrcaRuntimeWithAgentSessionResumeOwnership } from '../../session-lifecycle/projection/agent-session-resume-ownership'
import type {
  MobileTerminalCommand,
  MobileTerminalResumeCommand
} from '../launch/mobile-terminal-startup'
import type { PaneSpawnReservation } from '../../../ipc/pty/pane/spawn-reservation'
import { rejectPaneSpawnReservation } from '../../../ipc/pty/pane/spawn-reservation'
import type { PtySpawnStartupTarget } from '../../../ipc/pty/spawn-startup-target'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'

export type PreparedRestoredPaneStartup = {
  resumeStartup: Awaited<
    ReturnType<OrcaRuntimeWithAgentSessionResumeOwnership['resolvePaneOwnedResumeStartup']>
  >
  agentStartup: MobileTerminalCommand | MobileTerminalResumeCommand
}

/** One active replacement owns its reservation and fresh policy lease until the spawn accepts them. */
export class PreparedPaneReplacement {
  retainedAttempt?: RetainedTerminalAttempt
  private effectOwned = false
  private transferred = false
  private released = false

  constructor(
    readonly workspace: TerminalWorkspaceLaunchScope,
    readonly tabId: string,
    readonly leafId: string,
    readonly stoppedPtyId: string | undefined,
    readonly reservationKey: string,
    readonly reservation: PaneSpawnReservation,
    readonly startupTarget: PtySpawnStartupTarget,
    readonly startup: PreparedRestoredPaneStartup,
    private readonly releaseLease: () => void
  ) {}

  accept(args: {
    worktreeId?: string
    connectionId?: string | null
    tabId?: string
    leafId?: string
  }): () => void {
    if (
      this.transferred ||
      this.released ||
      args.worktreeId !== this.workspace.id ||
      (args.connectionId ?? null) !== this.workspace.connectionId ||
      args.tabId !== this.tabId ||
      args.leafId !== this.leafId
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    this.transferred = true
    return this.releaseLease
  }

  handoffToStart(): void {
    this.effectOwned = true
  }

  releaseIfUnclaimed(): void {
    if (!this.effectOwned) {
      this.releaseUnused()
    }
  }

  settleFailure(error: unknown): unknown {
    const attempt = takeRetainedTerminalAttempt(this)
    if (!attempt) {
      return error
    }
    const failure = settleRetainedTerminalOperationFailure(
      attempt,
      { key: this.reservationKey, reservation: this.reservation },
      error
    )
    this.releaseUnused(failure)
    return failure
  }

  releaseUnused(error?: unknown): void {
    if (this.transferred || this.released) {
      return
    }
    this.released = true
    this.retainedAttempt?.abandoned()
    this.retainedAttempt?.finalized()
    this.releaseLease()
    const resume = this.startup.resumeStartup
    if (resume && 'resumeClaim' in resume) {
      resume.resumeClaim?.settleFailure(false)
    }
    rejectPaneSpawnReservation(
      this.reservationKey,
      this.reservation,
      error ?? new Error('terminal_replacement_not_started')
    )
  }
}
