import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import { inspectProcessSignal } from '../../endpoint/identity/daemon-process-inspection'

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

  // Require a vanished PID, or the daemon's own idle-retirement acceptance; the PID proof fails closed on Windows.
  hasExited(adapter: DaemonPtyAdapter): boolean {
    if (typeof adapter.hasRetiredForIdle === 'function' && adapter.hasRetiredForIdle()) {
      return true
    }
    // Prefer current authenticated identity so a replacement is not judged by its predecessor's PID.
    const pid =
      (typeof adapter.getLastAuthenticatedDaemonIdentity === 'function'
        ? adapter.getLastAuthenticatedDaemonIdentity()?.pid
        : undefined) ?? this.pids.get(adapter)
    return (
      process.platform !== 'win32' && pid !== undefined && inspectProcessSignal(pid) === 'missing'
    )
  }
}
