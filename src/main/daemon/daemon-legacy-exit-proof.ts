import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { inspectProcessSignal } from './daemon-process-inspection'

/** Keeps the pid each legacy daemon last answered with; the client forgets it on disconnect. */
export class LegacyDaemonExitProof {
  private readonly pids = new WeakMap<DaemonPtyAdapter, number>()

  record(adapters: readonly DaemonPtyAdapter[]): void {
    for (const adapter of adapters) {
      const pid =
        typeof adapter.getDaemonIdentity === 'function' ? adapter.getDaemonIdentity()?.pid : null
      if (typeof pid === 'number') {
        this.pids.set(adapter, pid)
      }
    }
  }

  // Why: a refused or missing socket is loss of contact, not death; only a vanished pid proves the
  // daemon exited. Windows is excluded like probeDaemonProcessIdentity, so it keeps failing closed.
  hasExited(adapter: DaemonPtyAdapter): boolean {
    // Why the last authenticated pid first: a replacement daemon must not be judged by its predecessor's pid.
    const pid =
      (typeof adapter.getLastAuthenticatedDaemonIdentity === 'function'
        ? adapter.getLastAuthenticatedDaemonIdentity()?.pid
        : undefined) ?? this.pids.get(adapter)
    return (
      process.platform !== 'win32' && pid !== undefined && inspectProcessSignal(pid) === 'missing'
    )
  }
}
