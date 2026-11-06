/** A detached login-shell probe gets no terminal signals, so its owner ends it: on timeout and when the owner exits. */
import type { SpawnedProcess } from '@orca/process-host/process-spec'
import { signalProcessTree } from '@orca/process-host/process-tree-termination'

export type ShellProbeLifetime = {
  /** SIGKILL the probe and everything its rc started, even once the shell itself has exited. */
  kill: () => void
  /** The probe is settled: stop guarding it at owner exit, so daemons its rc started live on. */
  release: () => void
}

// No signal listeners: one would replace Electron's graceful signal quit, and every owner turns INT/TERM into an exit.
export function bindShellProbeLifetime(child: SpawnedProcess): ShellProbeLifetime {
  const kill = (): void => {
    if (process.platform === 'win32') {
      // Windows probes stay attached, and a tree kill would spawn taskkill from an exit hook.
      try {
        child.kill('SIGKILL')
      } catch {
        // Already exited.
      }
      return
    }
    // The probe's own group holds its rc's jobs (job control starts after the rc) and outlives the shell.
    void signalProcessTree(child, 'SIGKILL')
  }
  process.once('exit', kill)
  return { kill, release: () => process.off('exit', kill) }
}
