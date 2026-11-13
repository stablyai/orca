import type { DaemonClient } from '../../transport/client/daemon-client'
import { teardownReadBudgetMs } from '../../launch/daemon-request-deadline'
import { logSleepFolderRead, readDaemonWslSleepCwdWithFacts } from '../wsl/daemon-wsl-sleep-cwd'

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

/** Sleep's one folder read for a pane, WSL bridge or native, logged as one line either way. */
export async function readDaemonSleepFolder(
  client: Pick<DaemonClient, 'request'>,
  sessionId: string,
  pane: { wslDistro?: string; paneKey?: string; live: boolean; deadlineMs?: number }
): Promise<string | null> {
  const startedAt = Date.now()
  const read =
    pane.wslDistro && pane.paneKey
      ? // A live pane's own wsl.exe keeps its distro running.
        await readDaemonWslSleepCwdWithFacts(
          { paneKey: pane.paneKey, wslDistro: pane.wslDistro, live: pane.live },
          pane.deadlineMs
        )
      : {
          cwd: pane.live ? await readDaemonLiveSleepCwd(client, sessionId, pane.deadlineMs) : null
        }
  // Device runs need to see why a WSL pane woke at its spawn folder (awin 5e).
  logSleepFolderRead(sessionId, read, {
    wslDistro: pane.wslDistro,
    paneKey: pane.paneKey,
    live: pane.live,
    elapsedMs: Date.now() - startedAt
  })
  return read.cwd
}
