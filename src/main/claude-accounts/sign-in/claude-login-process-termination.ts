import type { ChildProcess } from 'node:child_process'
import type { WindowsHostInteractiveLoginSpawn } from '../../providers/shell-launch/windows/windows-interactive-login-spawn'
import { recordSelfInitiatedTreeKill } from '../../crash-reporting/process-exits/self-initiated-tree-kill-log'
import { admitSelfInitiatedTreeKill } from '../../pty/process-retirement/own-chromium-tree-kill-guard'
import { runWindowsTaskkillTree } from '../../pty/process-retirement/windows-process-tree-kill'

const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000

export function terminateClaudeProcess(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
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
    void runWindowsTaskkillTree(windowsTerminationPid, WINDOWS_TASKKILL_TIMEOUT_MS).then(
      (succeeded) => {
        if (!succeeded) {
          child.kill()
        }
        afterKill()
      }
    )
  }
  if (process.platform === 'win32') {
    // The login tree belongs to the relayed PID, not the wrapper.
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
      // Fall back to the direct child when group signaling fails.
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
