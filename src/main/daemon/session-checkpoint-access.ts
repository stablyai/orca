import type { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { SessionOutputPlane } from './session-output-plane'
import type { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'

type SessionCheckpointAccessDeps = {
  output: SessionOutputPlane
  shellReady: SessionShellReadyBarrier
  startupIngress: PtyStartupIngress
  recoveryBarrier: TerminalShellRecoveryBarrier
  isDisposed: () => boolean
}

export class SessionCheckpointAccess {
  constructor(private readonly deps: SessionCheckpointAccessDeps) {}

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot | null {
    this.deps.startupIngress.snapshotBarrier()
    return this.deps.output.getSnapshot(opts)
  }

  getPartialEscapeTailAnsi(): string {
    return this.deps.output.getPartialEscapeTailAnsi()
  }

  getAppliedSize(): { cols: number; rows: number } | null {
    return this.deps.output.getAppliedSize()
  }

  takePendingOutput(
    includeSnapshot: boolean,
    opts: { teardownSnapshot?: boolean } = {}
  ): TakePendingOutputResult | null {
    if (this.deps.isDisposed()) {
      return null
    }
    const releasedHeldBytes =
      includeSnapshot && opts.teardownSnapshot === true ? this.prepareForFinalSnapshot() : ''
    return this.deps.output.takePendingOutput(includeSnapshot, releasedHeldBytes, () =>
      this.getSnapshot()
    )
  }

  prepareForFinalSnapshot(): string {
    const held = this.deps.shellReady.releaseHeldBytes()
    this.deps.startupIngress.snapshotBarrier()
    // Why last: snapshotBarrier can emit held spans into the barrier, and a
    // teardown checkpoint mid-episode must not lose the barrier's queued bytes.
    this.deps.recoveryBarrier.flushPending()
    return held
  }
}
