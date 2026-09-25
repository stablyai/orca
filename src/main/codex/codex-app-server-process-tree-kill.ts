import { spawnProcess } from '../../shared/child-process/run-process'
import type { ChildProcessHandle, ProcessSpec } from '../../shared/child-process/process-spec'
import { admitProcessTreeKill } from '../../shared/child-process/process-tree-kill-gate'

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
      // Refusal blocks the tree walk, not the termination: the root kill is
      // handle-addressed, so it cannot reach the recycled pid we refused.
      child.kill('SIGKILL')
      return
    }
    try {
      // Why: npm-installed Codex runs behind cmd.exe; killing only that wrapper
      // leaves the app-server child alive after a timeout or failed shutdown.
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
      // npm/package-manager launchers insert a shim child on POSIX. Reap its
      // direct descendants before signalling the wrapper itself.
      const descendants = spawnImpl('pkill', ['-KILL', '-P', String(child.pid)], {
        stdio: 'ignore'
      })
      // A missing pkill surfaces as an async 'error' event, and an unhandled one
      // takes down the main process.
      descendants.on('error', () => undefined)
      descendants.unref()
    } catch {
      // The direct kill below remains the fallback when pkill is unavailable.
    }
  }
  child.kill('SIGKILL')
}
