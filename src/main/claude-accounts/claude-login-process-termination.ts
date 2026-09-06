import { spawnProcess, type ChildProcessHandle } from '../../shared/child-process/run-process'
import type { WindowsHostInteractiveLoginSpawn } from '../../shared/windows-interactive-login-spawn'
import { recordSelfInitiatedTreeKill } from '../crash-reporting/self-initiated-tree-kill-log'
import { admitSelfInitiatedTreeKill } from '../own-chromium-tree-kill-guard'

const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000

/** Ends a `claude` login and everything it spawned, then runs `afterKill`. */
export function terminateClaudeProcess(
  child: ChildProcessHandle,
  interactiveLogin: WindowsHostInteractiveLoginSpawn | null,
  afterKill: () => void
): void {
  const killWindowsTree = (windowsTerminationPid: number): void => {
    if (
      !admitSelfInitiatedTreeKill({
        pid: windowsTerminationPid,
        site: 'claude-account-login-teardown',
        scope: 'win-taskkill-tree'
      })
    ) {
      child.kill()
      afterKill()
      return
    }
    const taskkill = spawnProcess({
      program: 'taskkill.exe',
      args: ['/pid', String(windowsTerminationPid), '/t', '/f'],
      stdio: 'ignore'
    })
    let finished = false
    const finish = (succeeded: boolean): void => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(taskkillTimeout)
      if (!succeeded) {
        child.kill()
      }
      afterKill()
    }
    const taskkillTimeout = setTimeout(() => {
      taskkill.kill()
      finish(false)
    }, WINDOWS_TASKKILL_TIMEOUT_MS)
    taskkill.once('error', () => finish(false))
    taskkill.once('close', (code) => finish(code === 0))
  }
  if (process.platform === 'win32') {
    // The wrapper's own PID never owns the login tree, so prefer the relayed PID.
    const resolveTerminationPid = interactiveLogin?.waitForTerminationPid
      ? interactiveLogin.waitForTerminationPid()
      : Promise.resolve(interactiveLogin?.getTerminationPid?.() ?? child.pid ?? null)
    void resolveTerminationPid
      .then((windowsTerminationPid) => {
        if (windowsTerminationPid) {
          killWindowsTree(windowsTerminationPid)
          return
        }
        child.kill()
        afterKill()
      })
      .catch(() => {
        child.kill()
        afterKill()
      })
    return
  }
  if (child.pid) {
    let signaledGroup = false
    try {
      process.kill(-child.pid)
      signaledGroup = true
    } catch {
      // The direct child remains the only safe fallback when group lookup fails.
    }
    if (signaledGroup) {
      recordSelfInitiatedTreeKill({
        pid: child.pid,
        site: 'claude-account-login-teardown',
        scope: 'posix-process-group'
      })
      afterKill()
      return
    }
  }
  child.kill()
  afterKill()
}
