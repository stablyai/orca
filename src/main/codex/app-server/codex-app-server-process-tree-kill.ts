import { spawnProcess } from '@orca/process-host'
import type { ChildProcess } from 'node:child_process'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { admitProcessTreeKill } from '@orca/process-host/process-tree-kill-gate'
import { runWindowsTaskkillTree } from '../../pty/process-retirement/windows-process-tree-kill'

/** Spawn seam for tests; production always goes through the hardened spawnProcess wrapper. */
export type CodexAppServerSpawn = (
  program: string,
  args: string[],
  options: Record<string, unknown>
) => ChildProcess

export const spawnCodexAppServerProcess: CodexAppServerSpawn = (program, args, options) =>
  spawnProcess({ program, args, ...options } as ProcessSpec)

export function killCodexAppServerProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill' | 'exitCode' | 'signalCode'>,
  options: { platform?: NodeJS.Platform; spawnImpl?: CodexAppServerSpawn } = {}
): void {
  const platform = options.platform ?? process.platform
  const spawnImpl = options.spawnImpl ?? spawnCodexAppServerProcess
  // An exited root's pid can name another process (on Windows while pipes still delay close).
  if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) {
    return
  }
  if (platform === 'win32' && child.pid) {
    if (
      !admitProcessTreeKill({
        pid: child.pid,
        site: 'codex-app-server-session-deadline',
        scope: 'win-taskkill-tree'
      })
    ) {
      // A handle-addressed root kill cannot target the recycled PID refused by the tree gate.
      child.kill('SIGKILL')
      return
    }
    // npm launchers wrap Codex; killing only the wrapper leaves the app-server alive.
    void runWindowsTaskkillTree(child.pid).then((treeTerminated) => {
      if (!treeTerminated) {
        child.kill('SIGKILL')
      }
    })
    return
  }
  if (child.pid) {
    try {
      // Reap package-manager shim descendants before signalling their wrapper.
      const descendants = spawnImpl('pkill', ['-KILL', '-P', String(child.pid)], {
        stdio: 'ignore'
      })
      // Missing pkill emits an async error that must not crash the main process.
      descendants.on('error', () => undefined)
      descendants.unref()
    } catch {
      // The direct kill below remains the fallback when pkill is unavailable.
    }
  }
  child.kill('SIGKILL')
}
