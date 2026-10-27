/** Bridge WSL bash lacks OSC 7; read its shell folder before Sleep so wake avoids the spawn folder. Failures retain the old fallback. */
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import {
  readWslGuestPaneProcesses,
  readWslGuestPaneShellCwd
} from '../wsl/wsl-guest-pane-processes'
import { teardownReadBudgetMs } from './daemon-request-deadline'

// Reserve teardown time for the final checkpoint and kill when a distro does not answer.
const READ_BUDGET_MS = 3_000

/** The shell's folder in the bridge's UNC spelling, which wake reads; else null. */
export async function readDaemonWslSleepCwd(
  pane: { paneKey: string; wslDistro: string; live: boolean },
  deadlineMs?: number
): Promise<string | null> {
  const budget = teardownReadBudgetMs(READ_BUDGET_MS, deadlineMs)
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
