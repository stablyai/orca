/** A detached login-shell probe gets no terminal signals, so its owner ends it: on timeout and when the owner exits. */
import type { ChildProcess } from 'node:child_process'
import { signalProcessTree } from '@orca/process-host/process-tree-termination'

export type ShellProbeLifetime = {
  /** SIGKILL the probe and everything its rc started, even once the shell itself has exited. */
  kill: () => void
  /** The probe is settled: stop guarding it at owner exit, so daemons its rc started live on. */
  release: () => void
}

const activeProbes = new Set<() => void>()

export function killActiveShellProbes(): void {
  for (const kill of activeProbes) {
    kill()
  }
  activeProbes.clear()
  process.off('exit', killActiveShellProbes)
}

// Signal handlers belong to the process owner so Electron can shut down normally.
export function bindShellProbeLifetime(child: ChildProcess): ShellProbeLifetime {
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
  if (activeProbes.size === 0) {
    process.once('exit', killActiveShellProbes)
  }
  activeProbes.add(kill)
  return {
    kill,
    release: () => {
      activeProbes.delete(kill)
      if (activeProbes.size === 0) {
        process.off('exit', killActiveShellProbes)
      }
    }
  }
}
