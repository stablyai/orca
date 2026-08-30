import type { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { SessionOutputPlane } from './session-output-plane'
import type { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import type { TakePendingOutputResult, TerminalSnapshot } from './types'

export class SessionSnapshotAccess {
  constructor(
    private readonly output: SessionOutputPlane,
    private readonly shellReady: SessionShellReadyBarrier,
    private readonly startupIngress: PtyStartupIngress,
    private readonly recoveryBarrier: TerminalShellRecoveryBarrier
  ) {}

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot | null {
    this.startupIngress.snapshotBarrier()
    return this.output.getSnapshot(opts)
  }

  takePendingOutput(
    includeSnapshot: boolean,
    opts: { teardownSnapshot?: boolean } = {}
  ): TakePendingOutputResult | null {
    const released = includeSnapshot && opts.teardownSnapshot ? this.prepareForFinalSnapshot() : ''
    return this.output.takePendingOutput(includeSnapshot, released, () => this.getSnapshot())
  }

  prepareForFinalSnapshot(): string {
    const held = this.shellReady.releaseHeldBytes()
    this.startupIngress.snapshotBarrier()
    this.recoveryBarrier.flushPending()
    return held
  }
}
