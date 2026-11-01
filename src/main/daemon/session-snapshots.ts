import type { SessionOutputPlane } from './session-output-plane'
import type { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { TerminalSnapshot } from './types'

export abstract class SessionSnapshots {
  protected abstract readonly output: SessionOutputPlane
  abstract readonly startupIngress: PtyStartupIngress

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot | null {
    this.startupIngress.snapshotBarrier()
    return this.output.getSnapshot(opts)
  }

  getPartialEscapeTailAnsi(): string {
    return this.output.getPartialEscapeTailAnsi()
  }

  getAppliedSize(): { cols: number; rows: number } | null {
    return this.output.getAppliedSize()
  }
}
