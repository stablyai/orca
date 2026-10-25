/**
 * The folder a bridge WSL pane's shell is in when it sleeps. Bash on the bridge reports no folder
 * (no OSC 7), so without this the final checkpoint keeps the spawn folder and wake reopens the
 * pane at the workspace root. Windows only; any failure keeps that old behaviour.
 */
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import {
  readWslGuestPaneProcesses,
  readWslGuestPaneShellCwd
} from '../wsl/wsl-guest-pane-processes'

// Sleep waits on this; a distro that does not answer must not eat the teardown budget, which
// the final checkpoint and the kill still need.
const READ_BUDGET_MS = 3_000
const READ_SHARE_OF_DEADLINE = 0.25

/** The shell's folder in the bridge's UNC spelling, which wake reads; else null. */
export async function readDaemonWslSleepCwd(
  pane: { paneKey: string; wslDistro: string; live: boolean },
  deadlineMs?: number
): Promise<string | null> {
  const budget = Math.floor(
    Math.min(
      READ_BUDGET_MS,
      deadlineMs === undefined ? READ_BUDGET_MS : (deadlineMs - Date.now()) * READ_SHARE_OF_DEADLINE
    )
  )
  if (process.platform !== 'win32' || budget <= 0) {
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const rows = await Promise.race([
      readWslGuestPaneProcesses(pane.wslDistro, budget, { running: pane.live }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budget)
        timer.unref?.()
      })
    ])
    const cwd = rows ? readWslGuestPaneShellCwd(rows, pane.paneKey) : null
    return cwd && /^\/(?!\/)/.test(cwd) ? toWindowsWslUncPath(cwd, pane.wslDistro) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
