import { spawnProcess } from '@orca/process-host'
import type { ChildProcessHandle, ProcessSpec } from '@orca/process-host/process-spec'
import { admitProcessTreeKill } from '@orca/process-host/process-tree-kill-gate'

/** Spawn seam for tests; production always goes through the hardened spawnProcess wrapper. */
export type CodexAppServerSpawn = (
  program: string,
  args: string[],
  options: Record<string, unknown>
) => ChildProcessHandle

export const spawnCodexAppServerProcess: CodexAppServerSpawn = (program, args, options) =>
  spawnProcess({ program, args, ...options } as ProcessSpec)

export function killCodexAppServerProcessTree(
  child: Pick<ChildProcessHandle, 'pid' | 'kill'>,
  options: { platform?: NodeJS.Platform; spawnImpl?: CodexAppServerSpawn } = {}
): void {
  const platform = options.platform ?? process.platform
  const spawnImpl = options.spawnImpl ?? spawnCodexAppServerProcess
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
    try {
      // npm launchers wrap Codex; killing only the wrapper leaves the app-server alive.
      const killer = spawnImpl('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      let fellBack = false
      const killDirectChild = (): void => {
        if (!fellBack) {
          fellBack = true
          child.kill('SIGKILL')
        }
      }
      killer.on('error', killDirectChild)
      killer.on('exit', (code) => {
        if (code !== 0) {
          killDirectChild()
        }
      })
      killer.unref()
      return
    } catch {
      // Fall through to the direct-child best effort when taskkill cannot start.
    }
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
