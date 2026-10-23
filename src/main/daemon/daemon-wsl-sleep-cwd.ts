/**
 * The folder a bridge WSL pane's shell is in when it sleeps. Bash on the bridge reports no folder
 * (no OSC 7), so without this the final checkpoint keeps the spawn folder and both wake and a move
 * reopen the pane at the workspace root. Main registers the reader; with none nothing changes.
 */
import { toWindowsWslUncPath } from '../../shared/wsl-paths'

export type DaemonWslSleepCwdReader = (
  sessionId: string,
  wslDistro: string
) => Promise<string | null>

// Sleep waits on this; a distro that does not answer must not eat the teardown budget, which
// the final checkpoint and the kill still need.
const READ_BUDGET_MS = 3_000
const READ_SHARE_OF_DEADLINE = 0.25

let reader: DaemonWslSleepCwdReader | null = null

export function setDaemonWslSleepCwdReader(next: DaemonWslSleepCwdReader | null): void {
  reader = next
}

/** The shell's folder in the bridge's UNC spelling, which wake and the move both read; else null. */
export async function readDaemonWslSleepCwd(
  sessionId: string,
  wslDistro: string,
  deadlineMs?: number
): Promise<string | null> {
  const read = reader
  const budget = Math.min(
    READ_BUDGET_MS,
    deadlineMs === undefined ? READ_BUDGET_MS : (deadlineMs - Date.now()) * READ_SHARE_OF_DEADLINE
  )
  if (!read || budget <= 0) {
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const cwd = await Promise.race([
      read(sessionId, wslDistro),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budget)
        timer.unref?.()
      })
    ])
    if (!cwd || !/^\/(?!\/)/.test(cwd)) {
      // awin verify-5: an open pane reopened at its root; this says whether the read was the gap.
      console.info('[wsl-sleep-cwd] No shell folder read for a sleeping WSL pane:', sessionId)
      return null
    }
    return toWindowsWslUncPath(cwd, wslDistro)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
