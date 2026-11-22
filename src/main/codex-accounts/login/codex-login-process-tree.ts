import { spawnProcess } from '@orca/process-host'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { admitSelfInitiatedTreeKill } from '../../pty/process-retirement/own-chromium-tree-kill-guard'
import type { WindowsHostInteractiveLoginSpawn } from '../../providers/shell-launch/windows/windows-interactive-login-spawn'
import type { CodexLoginChild } from './codex-login-session'

const WINDOWS_LOGIN_TREE_KILL_TIMEOUT_MS = 5_000

export function killCodexLoginProcessTree(
  child: CodexLoginChild,
  interactiveLogin?: WindowsHostInteractiveLoginSpawn | null
): void {
  const pid = interactiveLogin?.getTerminationPid?.() ?? child.pid
  if (
    process.platform === 'win32' &&
    typeof pid === 'number' &&
    (child.exitCode ?? child.signalCode) === null &&
    admitSelfInitiatedTreeKill({
      pid,
      site: 'codex-account-login-teardown',
      scope: 'win-taskkill-tree'
    })
  ) {
    const taskkill = spawnProcess({
      program: windowsSystem32Binary('taskkill.exe'),
      args: ['/pid', String(pid), '/t', '/f'],
      stdio: 'ignore'
    })
    let finished = false
    const finish = (succeeded: boolean): void => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timeout)
      if (!succeeded) {
        child.kill()
      }
    }
    const timeout = setTimeout(() => {
      taskkill.kill()
      finish(false)
    }, WINDOWS_LOGIN_TREE_KILL_TIMEOUT_MS)
    taskkill.once('error', () => finish(false))
    taskkill.once('close', (code) => finish(code === 0))
    return
  }
  child.kill()
}
