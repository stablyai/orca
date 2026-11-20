import type { WindowsHostInteractiveLoginSpawn } from '../../providers/shell-launch/windows/windows-interactive-login-spawn'
import { admitSelfInitiatedTreeKill } from '../../pty/process-retirement/own-chromium-tree-kill-guard'
import { runWindowsTaskkillTree } from '../../pty/process-retirement/windows-process-tree-kill'
import type { CodexLoginChild } from './codex-login-session'

const WINDOWS_LOGIN_TREE_KILL_TIMEOUT_MS = 5_000

export function killLoginProcessTree(
  child: CodexLoginChild,
  interactiveLogin?: WindowsHostInteractiveLoginSpawn | null
): Promise<void> {
  const terminationPid = interactiveLogin?.getTerminationPid?.() ?? child.pid
  if (
    process.platform === 'win32' &&
    typeof terminationPid === 'number' &&
    (child.exitCode ?? child.signalCode) === null &&
    // Record only attempted kills; Electron-owned PIDs fall back to a direct signal.
    admitSelfInitiatedTreeKill({
      pid: terminationPid,
      site: 'codex-account-login-teardown',
      scope: 'win-taskkill-tree'
    })
  ) {
    // Kill descendants too: their Windows file handles can block post-login home operations.
    return runWindowsTaskkillTree(terminationPid, WINDOWS_LOGIN_TREE_KILL_TIMEOUT_MS).then(
      (treeEnded) => {
        if (!treeEnded) {
          child.kill()
        }
      }
    )
  }
  child.kill()
  return Promise.resolve()
}
