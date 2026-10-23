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

// Sleep waits on this; a distro that does not answer must not eat the teardown budget.
const READ_BUDGET_MS = 3_000

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
    deadlineMs === undefined ? READ_BUDGET_MS : deadlineMs - Date.now()
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
    return cwd && /^\/(?!\/)/.test(cwd) ? toWindowsWslUncPath(cwd, wslDistro) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
