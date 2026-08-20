import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createProcessTableSnapshotReader } from '../../shared/process-table-snapshot'
import {
  readWindowsProcessRowsWithWmic,
  resetWmicProcessTableReaderForTests
} from './windows-wmic-process-table'

const execFileAsync = promisify(execFile)
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 3_000
// Why: CommandLine can contain CR/LF text. JSON keeps process fields structured
// so an argument cannot masquerade as another `Name=` / `ProcessId=` row.
const POWERSHELL_PROCESS_QUERY =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  'Get-CimInstance -ClassName Win32_Process ' +
  '-Property CommandLine,ExecutablePath,Name,ParentProcessId,ProcessId | ' +
  'Select-Object CommandLine,ExecutablePath,Name,ParentProcessId,ProcessId | ' +
  'ConvertTo-Json -Compress'

export type WindowsProcessRow = {
  pid: number
  ppid: number
  name: string
  command: string
  executablePath: string
}

export type WindowsProcessCandidate = WindowsProcessRow & { depth: number }

// Why: agent foreground inspection forks a whole-process-table PowerShell/CIM
// scan per pane on the same 750ms/2000ms cadence as the POSIX `ps` path. Without
// dedup, K concurrent agent panes fork K powershell.exe cold-starts, each ~10-40x
// heavier than `ps` — the Windows analogue of the idle-CPU churn #6288/#6667 fixed
// for POSIX. Reuse the same TTL + single-in-flight reader, caching parsed rows so
// a burst of panes collapses to ~2 scans/sec; every caller runs its own descendant
// walk over the shared snapshot.
// Why #15209: every PowerShell-host spawn writes a transcript file under the
// enterprise Windows PowerShell transcription GPO, and this scan re-forks ~2x/s
// while panes are open. wmic reads the same table with no PowerShell host, so it
// leads here; see ./windows-wmic-process-table for what that costs and why the
// teardown reader below deliberately does not use it.
async function runWindowsProcessRows(): Promise<WindowsProcessRow[]> {
  const rows =
    (await readWindowsProcessRowsWithWmic()) ?? (await queryWindowsProcessesWithPowerShell())
  if (!rows) {
    // Reject so the reader does not cache the miss; callers fall through to
    // node-pty's process name (the prior null-return contract is preserved by
    // queryWindowsProcessDescendants catching this).
    throw new Error('windows process enumeration unavailable')
  }
  return rows
}

const windowsProcessRowsReader = createProcessTableSnapshotReader<WindowsProcessRow[]>({
  runPs: runWindowsProcessRows,
  now: () => Date.now()
})

// Why this one never reads wmic: `/format:value` has no escaping and CommandLine
// is whatever some process chose to be launched with, so a command line can emit
// a fully well-formed record — blank-line separator and a following `CommandLine=`
// to resynchronise — that no parser can tell from a real one. An invented
// `{pid, ppid}` row is not inert: it bridges a real orphan to our own pid, and
// classifyWindowsTreeKillTarget then reads an unrelated tree as `own` and lets
// `taskkill /T /F` have it. Ancestry that gates a force-kill therefore comes only
// from the JSON reader, where a field cannot masquerade as a record.
//
// The cost is bounded: this fires on teardown, not on the ~2x/s cadence #15209 is
// about, so it is one transcript file per teardown against the 172,800 a day the
// foreground scan was writing.
const windowsProcessLinksReader = createProcessTableSnapshotReader<WindowsProcessRow[]>({
  runPs: async () => {
    const rows = await queryWindowsProcessesWithPowerShell()
    if (!rows) {
      throw new Error('windows process enumeration unavailable')
    }
    return rows
  },
  now: () => Date.now()
})

/**
 * Rows from a scan that starts after this call. PID-identity checks in teardown
 * must not reuse a cached row — it can predate the very recycle it detects — but
 * they must still dedupe: a worktree delete tears down PTYs 32-wide, so a bypass
 * would fork that many powershell cold-starts. Rejects when the scan fails.
 */
export function queryWindowsProcessRowsFresh(): Promise<WindowsProcessRow[]> {
  return windowsProcessLinksReader.getFreshSnapshot()
}

export async function queryWindowsProcessDescendants(
  rootPid: number,
  options: { fresh?: boolean } = {}
): Promise<WindowsProcessCandidate[] | null> {
  let rows: WindowsProcessRow[]
  try {
    rows =
      options.fresh === true
        ? await windowsProcessRowsReader.getFreshSnapshot()
        : await windowsProcessRowsReader.getSnapshot()
  } catch {
    return null
  }
  // Why: a snapshot that omitted the PTY root may be stale or permission-
  // filtered; only an observed root can authoritatively have no descendants.
  if (!rows.some((row) => row.pid === rootPid)) {
    return null
  }
  return collectDescendants(rows, rootPid).sort((a, b) => b.depth - a.depth)
}

/**
 * Test-only: clear the shared Windows process-table snapshot so suites that mock
 * execFile between cases don't get one case's rows served to the next within TTL,
 * and un-demote wmic so a case can pick which reader answers it. Both are
 * process-lifetime state, so leaving either set leaks one case into the next.
 */
export function resetWindowsProcessRowsReaderForTests(): void {
  resetWmicProcessTableReaderForTests()
  windowsProcessRowsReader.reset()
  windowsProcessLinksReader.reset()
}

type WindowsProcessJsonRow = {
  CommandLine?: unknown
  ExecutablePath?: unknown
  Name?: unknown
  ParentProcessId?: unknown
  ProcessId?: unknown
}

function parseWindowsProcessJsonRows(stdout: string): WindowsProcessRow[] | null {
  const trimmed = stdout.trim()
  if (!trimmed) {
    return []
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown
    const items = Array.isArray(parsed) ? parsed : [parsed]
    return items.flatMap((item) => {
      if (!item || typeof item !== 'object') {
        return []
      }
      const row = item as WindowsProcessJsonRow
      const pid = numberFromWindowsProcessField(row.ProcessId)
      const ppid = numberFromWindowsProcessField(row.ParentProcessId)
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
        return []
      }
      const name = stringFromWindowsProcessField(row.Name)
      const command = stringFromWindowsProcessField(row.CommandLine) || name
      return [
        {
          pid,
          ppid,
          name,
          command,
          executablePath: stringFromWindowsProcessField(row.ExecutablePath)
        }
      ]
    })
  } catch {
    return null
  }
}

function stringFromWindowsProcessField(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value === null || value === undefined) {
    return ''
  }
  return String(value)
}

function numberFromWindowsProcessField(value: unknown): number {
  if (typeof value === 'number') {
    return value
  }
  if (typeof value === 'string') {
    return Number.parseInt(value, 10)
  }
  return Number.NaN
}

function collectDescendants<Row extends { pid: number; ppid: number }>(
  rows: Row[],
  rootPid: number
): (Row & { depth: number })[] {
  const childrenByParent = new Map<number, Row[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row)
    childrenByParent.set(row.ppid, children)
  }

  const descendants: (Row & { depth: number })[] = []
  // Why visited: ppid is historical, so a recycled pid can point a live process at
  // a descendant of itself and close a loop — and every Windows table ships one
  // outright, System Idle Process being its own parent at pid 0. Unguarded, this
  // walk never terminates, and it runs on the daemon's ~2x/s cadence.
  const visited = new Set<number>([rootPid])
  const stack = (childrenByParent.get(rootPid) ?? []).map((row) => ({ row, depth: 1 }))
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!
    if (visited.has(row.pid)) {
      continue
    }
    visited.add(row.pid)
    descendants.push({ ...row, depth })
    for (const child of childrenByParent.get(row.pid) ?? []) {
      stack.push({ row: child, depth: depth + 1 })
    }
  }
  return descendants
}

/** Runs the PowerShell/CIM whole-process-table scan; returns null when unavailable. */
async function queryWindowsProcessesWithPowerShell(): Promise<WindowsProcessRow[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_PROCESS_QUERY],
      {
        encoding: 'utf8',
        timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        // Why: this scan re-forks on a ~1s/pane cadence. Electron's main has no
        // console, so without windowsHide each fork pops a fresh conhost window
        // that flashes and steals keyboard focus from the foreground app
        // (including Orca's own terminal).
        windowsHide: true
      }
    )
    const rows = parseWindowsProcessJsonRows(stdout)
    return rows && rows.length > 0 ? rows : null
  } catch {
    return null
  }
}
