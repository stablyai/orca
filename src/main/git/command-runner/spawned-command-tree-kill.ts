import { spawn, type ChildProcess } from 'node:child_process'
import { admitSelfInitiatedTreeKill } from '../../own-chromium-tree-kill-guard'

const WINDOWS_TREE_KILL_WAIT_MS = 2_000

export function killSpawnedCommandTree(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>
): Promise<void> {
  const pid = child.pid
  if (!pid || process.platform !== 'win32') {
    child.kill()
    return Promise.resolve()
  }
  // Windows may reuse the pid after exit while inherited pipes still delay close.
  if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) {
    child.kill()
    return Promise.resolve()
  }
  if (
    !admitSelfInitiatedTreeKill({ pid, site: 'git-command-tree-kill', scope: 'win-taskkill-tree' })
  ) {
    // A refused PID tree walk still permits handle-based root termination without risking a reused PID.
    child.kill()
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let killer: ChildProcess
    try {
      // Await Windows tree cleanup so shim/WSL descendants cannot outlive their probe.
      killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      })
      if (!killer || typeof killer.unref !== 'function') {
        child.kill()
        resolve()
        return
      }
    } catch {
      child.kill()
      resolve()
      return
    }
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const finish = (fallbackToChildKill: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      killer.removeAllListeners()
      if (fallbackToChildKill) {
        child.kill()
      }
      resolve()
    }
    killer.once('error', () => finish(true))
    killer.once('close', (code) => finish(code !== 0))
    timer = setTimeout(() => {
      killer.kill()
      finish(true)
    }, WINDOWS_TREE_KILL_WAIT_MS)
    killer.unref()
  })
}
