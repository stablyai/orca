import { terminateWindowsProcessTree, type WindowsTreeKiller } from '../windows-process-tree-kill'

// Hard-killing during rotating-token refresh can invalidate auth.json; request shutdown, then allow a bounded drain.

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
    // exit/close prove child release; error alone cannot prove auth.json is free after a successful spawn.
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
  // Stdio EOF is graceful on Windows; Node signals there call TerminateProcess. POSIX SIGTERM backs up EOF.
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
      // Kill launcher descendants too, or app-server may outlive the wrapper after its lock is released.
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
