import type { DaemonClient } from './client'
import { teardownReadBudgetMs } from './daemon-request-deadline'

const LIVE_SLEEP_CWD_BUDGET_MS = 1_500

/**
 * A native shell's folder at Sleep (OSC 7, else its process's cwd). Bash prints no OSC 7, so
 * without this the checkpoint keeps the spawn folder and Wake opens there (e.g. on a Linux host).
 */
export async function readDaemonLiveSleepCwd(
  client: Pick<DaemonClient, 'request'>,
  sessionId: string,
  deadlineMs?: number
): Promise<string | null> {
  // Windows has no process-cwd lookup (it would spawn a missing lsof); the snapshot's OSC 7 cwd stands.
  const budget = teardownReadBudgetMs(LIVE_SLEEP_CWD_BUDGET_MS, deadlineMs)
  if (process.platform === 'win32' || budget <= 0) {
    return null
  }
  try {
    const { cwd } = await client.request<{ cwd: string | null }>('getCwd', { sessionId }, budget)
    // A removed folder reads back from /proc as `<path> (deleted)`, which no shell can return to.
    return cwd && !cwd.endsWith(' (deleted)') ? cwd : null
  } catch {
    return null
  }
}
