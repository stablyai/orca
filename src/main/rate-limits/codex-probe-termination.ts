import { terminateWindowsProcessTree, type WindowsTreeKiller } from '../windows-process-tree-kill'

// Why: Codex OAuth uses rotating refresh tokens. Hard-killing a probe's
// app-server mid-refresh can strand auth.json between rotations and permanently
// invalidate the stored credential, so termination always requests shutdown
// first and only escalates after a bounded drain window.

export const CODEX_PROBE_SHUTDOWN_DRAIN_MS = 5_000
const HARD_KILL_EXIT_WAIT_MS = 1_000

export type TerminatableProbeChild = {
  pid?: number
  exitCode: number | null
  signalCode?: NodeJS.Signals | null
  kill: (signal?: NodeJS.Signals) => boolean
  on: (event: 'error', listener: () => void) => unknown
  once: (event: 'exit' | 'close' | 'error', listener: () => void) => unknown
  off: (event: 'exit' | 'close' | 'error', listener: () => void) => unknown
  stdin?: { end: () => void } | null
}

export type TerminateCodexProbeOptions = {
  drainMs?: number
  hardKillWaitMs?: number
  // Why: injectable so the Windows branch is testable from POSIX CI hosts.
  platform?: NodeJS.Platform
  killWindowsProcessTree?: WindowsTreeKiller
}

function hasExited(child: TerminatableProbeChild): boolean {
  return child.exitCode != null || child.signalCode != null
}

function waitForExit(child: TerminatableProbeChild, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = (exited: boolean): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      child.off('exit', onGone)
      child.off('close', onGone)
      child.off('error', onError)
      resolve(exited)
    }
    const onGone = (): void => settle(true)
    const onError = (): void => {
      // Keep ChildProcess errors observed, but only exit/close proves it is gone.
    }
    // Node emits 'close' after both exit and spawn failure. A later 'error'
    // alone does not prove a successfully spawned child released auth.json.
    child.once('exit', onGone)
    child.once('close', onGone)
    child.on('error', onError)
    timer = setTimeout(() => settle(false), timeoutMs)
  })
}

export async function terminateCodexProbeChild(
  child: TerminatableProbeChild,
  options?: TerminateCodexProbeOptions
): Promise<void> {
  if (hasExited(child)) {
    return
  }
  const platform = options?.platform ?? process.platform
  // Why: stdin EOF is the graceful stop for a stdio JSON-RPC server and the
  // only non-forceful request Windows has; SIGTERM backs it up where signals
  // are real (Node's kill() on Windows is always TerminateProcess).
  try {
    child.stdin?.end()
  } catch {
    // stdin may already be destroyed; the signal/kill path still applies.
  }
  if (platform !== 'win32') {
    try {
      child.kill('SIGTERM')
    } catch {
      // Already-exited children can race the kill; the exit wait handles it.
    }
  }
  if (await waitForExit(child, options?.drainMs ?? CODEX_PROBE_SHUTDOWN_DRAIN_MS)) {
    return
  }
  if (platform === 'win32' && child.pid) {
    try {
      // npm-installed Codex runs beneath cmd.exe; killing only that wrapper can
      // leave app-server alive after the credential-home lock is released.
      await (options?.killWindowsProcessTree ?? terminateWindowsProcessTree)(child.pid, {
        site: 'codex-rate-limit-probe'
      })
    } catch {
      // The direct-child fallback still applies if an injected killer rejects.
    }
  }
  if (hasExited(child)) {
    return
  }
  try {
    if (platform === 'win32') {
      child.kill()
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    // Already-exited children can race the kill; the exit wait handles it.
  }
  await waitForExit(child, options?.hardKillWaitMs ?? HARD_KILL_EXIT_WAIT_MS)
}
