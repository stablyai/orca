/** Bridge WSL bash lacks OSC 7; read its shell folder before Sleep so wake avoids the spawn folder. Failures retain the old fallback. */
import { toWindowsWslUncPath } from '../../shared/wsl-paths'
import { redactPtyIdForDiagnostics } from '../../shared/pty-delivery-diagnostics'
import { paneShells, readWslGuestPaneProcesses } from '../wsl/wsl-guest-pane-processes'
import { teardownReadBudgetMs } from './daemon-request-deadline'
import { logWslPaneDiagnostic } from './daemon-wsl-diagnostic-log'

// Reserve teardown time for the final checkpoint and kill when a distro does not answer.
const READ_BUDGET_MS = 3_000

/** What a Sleep's folder read saw, for the one diagnostic line Sleep logs. */
export type DaemonWslSleepCwdRead = {
  cwd: string | null
  budgetMs: number
  /** Process rows the distro returned; null when it was not read, refused, failed or timed out. */
  rows: number | null
  /** Shells tagged with the pane's key; a folder is taken only when exactly one owns it. */
  shells: number | null
  timedOut: boolean
}

/** The shell's folder in the bridge's UNC spelling, which wake reads; else null. */
export async function readDaemonWslSleepCwd(
  pane: { paneKey: string; wslDistro: string; live: boolean },
  deadlineMs?: number,
  capMs = READ_BUDGET_MS
): Promise<string | null> {
  return (await readDaemonWslSleepCwdWithFacts(pane, deadlineMs, capMs)).cwd
}

export async function readDaemonWslSleepCwdWithFacts(
  pane: { paneKey: string; wslDistro: string; live: boolean },
  deadlineMs?: number,
  capMs = READ_BUDGET_MS
): Promise<DaemonWslSleepCwdRead> {
  const budgetMs = teardownReadBudgetMs(capMs, deadlineMs)
  const none = { cwd: null, budgetMs, rows: null, shells: null, timedOut: false }
  if (process.platform !== 'win32' || budgetMs <= 0) {
    return none
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const rows = await Promise.race([
      readWslGuestPaneProcesses(pane.wslDistro, budgetMs, { running: pane.live }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          resolve(null)
        }, budgetMs)
        timer.unref?.()
      })
    ])
    if (!rows) {
      return { ...none, timedOut }
    }
    const shells = paneShells(rows, pane.paneKey)
    const cwd = shells.length === 1 ? (shells[0].cwd ?? null) : null
    return {
      cwd: cwd && /^\/(?!\/)/.test(cwd) ? toWindowsWslUncPath(cwd, pane.wslDistro) : null,
      budgetMs,
      rows: rows.length,
      shells: shells.length,
      timedOut: false
    }
  } catch {
    return none
  } finally {
    clearTimeout(timer)
  }
}

/** Quit's once-only read of live bridge panes' folders, in parallel within one budget; a distro read is shared. */
export async function readDaemonWslQuitCwds(
  panes: readonly { sessionId: string; paneKey: string; wslDistro: string }[],
  budgetMs: number
): Promise<Map<string, string>> {
  const cwds = new Map<string, string>()
  await Promise.all(
    panes.map(async (pane) => {
      // `live` only skips a fresh running check when the running-distro cache already confirms it.
      const cwd = await readDaemonWslSleepCwd({ ...pane, live: true }, undefined, budgetMs)
      if (cwd) {
        cwds.set(pane.sessionId, cwd)
      }
    })
  )
  return cwds
}

/** One info line per Sleep: which read ran, what it knew about the pane and what came back. */
export function describeSleepFolderRead(
  sessionId: string,
  read: DaemonWslSleepCwdRead | { cwd: string | null },
  pane: { wslDistro?: string; paneKey?: string; live: boolean; elapsedMs: number },
  opts: { withDistro: boolean } = { withDistro: true }
): string {
  const probe =
    'rows' in read
      ? `wsl probe (budget ${read.budgetMs}ms, rows ${read.rows ?? 'none'}${read.timedOut ? ' timed out' : ''}, shells ${read.shells ?? 'none'})`
      : 'live probe'
  // The session id embeds the worktree path; the distro name can be personal (trace only).
  const distro = opts.withDistro ? `, distro ${pane.wslDistro ?? 'unknown'}` : ''
  return `[history] Sleep folder for ${redactPtyIdForDiagnostics(sessionId)}: ${probe}${distro}, pane ${pane.paneKey ?? 'unknown'}, live ${pane.live}, folder ${read.cwd ? 'found' : 'not found'} in ${pane.elapsedMs}ms`
}

export function logSleepFolderRead(
  sessionId: string,
  read: DaemonWslSleepCwdRead | { cwd: string | null },
  pane: { wslDistro?: string; paneKey?: string; live: boolean; elapsedMs: number }
): void {
  logWslPaneDiagnostic(
    'wsl.sleep-folder',
    {
      console: describeSleepFolderRead(sessionId, read, pane),
      trace: describeSleepFolderRead(sessionId, read, pane, { withDistro: false })
    },
    sleepFolderAttributes(read, pane)
  )
}

/** The same facts as the line, as fields a trace reader can filter on. */
function sleepFolderAttributes(
  read: DaemonWslSleepCwdRead | { cwd: string | null },
  pane: { live: boolean; elapsedMs: number }
): Record<string, string | number | boolean | null> {
  return {
    probe: 'rows' in read ? 'wsl' : 'live',
    live: pane.live,
    folderFound: read.cwd !== null,
    elapsedMs: pane.elapsedMs,
    ...('rows' in read
      ? { rows: read.rows, shells: read.shells, timedOut: read.timedOut, budgetMs: read.budgetMs }
      : {})
  }
}
