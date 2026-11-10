/** A detached login-shell probe gets no terminal signals, so its owner ends it: on timeout and when the owner exits. */
import type { ChildProcess } from 'node:child_process'
import { signalProcessTree } from '@orca/process-host/process-tree-termination'

/** Grace between the polite signal and the force kill; an interactive rc's daemon exits on its own within this. */
export const SHELL_PROBE_TERMINATE_GRACE_MS = 300

export type ShellProbeLifetime = {
  /** End a timed-out probe politely first, then force-kill whatever is left. */
  terminate: () => void
  /** Force-kill now, for an owner that is exiting and cannot wait. */
  kill: () => void
  /** The probe is settled: stop guarding it at owner exit, so daemons its rc started live on. */
  release: () => void
}

// No signal listeners: one would replace Electron's graceful signal quit, and every owner turns INT/TERM into an exit.
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
  const terminate = (): void => {
    if (process.platform === 'win32') {
      kill()
      return
    }
    // Why: SIGKILL forecloses the rc child's own cleanup, so a zellij/tmux client killed that way leaves the
    // session server it started behind. Give it the terminal-hangup signal first, then force what remains.
    void signalProcessTree(child, 'SIGTERM')
    const force = setTimeout(() => {
      void signalProcessTree(child, 'SIGKILL')
    }, SHELL_PROBE_TERMINATE_GRACE_MS)
    force.unref?.()
  }
  process.once('exit', kill)
  return { terminate, kill, release: () => process.off('exit', kill) }
}
