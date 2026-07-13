import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createProcessTableSnapshotReader } from '../../shared/process-table-snapshot'

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
async function runWindowsProcessRows(): Promise<WindowsProcessRow[]> {
  const rows =
    (await queryWindowsProcessesWithPowerShell()) ?? (await queryWindowsProcessesWithWmic())
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
 * execFile between cases don't get one case's rows served to the next within TTL.
 */
export function resetWindowsProcessRowsSnapshotForTests(): void {
  windowsProcessRowsReader.reset()
}

function parseWindowsProcessValueRows(stdout: string): WindowsProcessRow[] {
  const rows: WindowsProcessRow[] = []
  let command = ''
  let executablePath = ''
  let name = ''
  let pid = Number.NaN
  let ppid = Number.NaN

  const flush = (): void => {
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      rows.push({ pid, ppid, name, command: command || name, executablePath })
    }
    command = ''
    executablePath = ''
    name = ''
    pid = Number.NaN
    ppid = Number.NaN
  }

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) {
      continue
    }
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (key === 'CommandLine') {
      command = value
    } else if (key === 'ExecutablePath') {
      executablePath = value
    } else if (key === 'Name') {
      name = value
    } else if (key === 'ParentProcessId') {
      ppid = Number.parseInt(value, 10)
    } else if (key === 'ProcessId') {
      pid = Number.parseInt(value, 10)
    }
  }
  flush()
  return rows
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
  const stack = (childrenByParent.get(rootPid) ?? []).map((row) => ({ row, depth: 1 }))
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!
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

/** Fallback whole-process-table scan via wmic when PowerShell is unavailable. */
async function queryWindowsProcessesWithWmic(): Promise<WindowsProcessRow[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'wmic',
      [
        'process',
        'get',
        'CommandLine,ExecutablePath,Name,ParentProcessId,ProcessId',
        '/format:value'
      ],
      {
        encoding: 'utf8',
        timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        // Why: same focus-stealing hazard as the powershell probe — hide the
        // wmic fallback's console window too.
        windowsHide: true
      }
    )
    const rows = parseWindowsProcessValueRows(stdout)
    return rows.length > 0 ? rows : null
  } catch {
    // Best-effort: Windows process enumeration may be disabled, so callers
    // still fall back to node-pty's process name when both probes fail.
    return null
  }
}
