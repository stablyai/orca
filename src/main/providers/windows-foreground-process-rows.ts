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
// Why #15209: every PowerShell-host spawn writes a transcript file under the
// enterprise Windows PowerShell transcription GPO, and this scan re-forks ~2x/s
// while panes are open — 1.4M files / 289GB in three weeks on one reported
// machine. wmic reads the same table with no PowerShell host, so it leads;
// PowerShell stays the fallback and is the only option where wmic is absent
// (24H2+ removed it), which leaves those builds on today's behaviour.
const WMIC_SCAN_FAILURE_LIMIT = 3
// Why the absolute path and not `wmic`: a bare name resolves through PATH, and on
// 24H2+ no legitimate wmic exists — so any `wmic.exe` a PATH entry offers there is
// by definition not the system one. The daemon runs this ~2x/s and targets
// `taskkill /T /F` off its output, so it reads only the one canonical location.
const WMIC_PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\wbem\\wmic.exe`
let wmicDemoted = false
let wmicScanFailures = 0

/**
 * wmic rows, or null to let PowerShell answer this scan.
 *
 * Why demote instead of probing `wmic /?`: a probe proves the binary exists, not
 * that we can read its table, and the answer to both is the same — stop spending
 * a wmic spawn per scan on top of the PowerShell one. An unreadable table demotes
 * at once; a transient WMI failure gets `WMIC_SCAN_FAILURE_LIMIT` scans of grace
 * so one hiccup does not cost the fix for the rest of the process lifetime.
 */
async function readWindowsProcessRowsWithWmic(): Promise<WindowsProcessRow[] | null> {
  if (wmicDemoted) {
    return null
  }
  const scan = await queryWindowsProcessesWithWmic()
  if (scan.status === 'ok') {
    wmicScanFailures = 0
    return scan.rows
  }
  wmicScanFailures += 1
  wmicDemoted = scan.status === 'unsupported' || wmicScanFailures >= WMIC_SCAN_FAILURE_LIMIT
  return null
}

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

/**
 * Rows from a scan that starts after this call. PID-identity checks in teardown
 * must not reuse a cached row — it can predate the very recycle it detects — but
 * they must still dedupe: a worktree delete tears down PTYs 32-wide, so a bypass
 * would fork that many powershell cold-starts. Rejects when both readers fail.
 */
export function queryWindowsProcessRowsFresh(): Promise<WindowsProcessRow[]> {
  return windowsProcessRowsReader.getFreshSnapshot()
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
  windowsProcessRowsReader.reset()
  wmicDemoted = false
  wmicScanFailures = 0
}

// wmic /format:value emits one `Key=Value` line per property in this fixed order,
// records separated by a blank line.
const WMIC_VALUE_FIELDS = [
  'CommandLine',
  'ExecutablePath',
  'Name',
  'ParentProcessId',
  'ProcessId'
] as const

/**
 * Parse wmic's `Key=Value` records.
 *
 * CommandLine is the one property that carries raw CR/LF, and Orca's own panes
 * put it there constantly (`bash -lc $'...\n...'`). So inside a record only the
 * next property in order opens a field; every other line continues the field
 * being read, which is what keeps `$'echo a\nProcessId=4'` one row instead of
 * two malformed ones — the hazard that made the PowerShell reader ask for JSON.
 * Between records any property may open one, so a process whose CommandLine is
 * NULL still parses, and a record missing a middle property merges into the next
 * rather than desyncing the rest of the table.
 *
 * Residue: a command line embedding the whole `ExecutablePath`..`ProcessId` tail
 * in order forges a row. It cannot suppress its own real row, so a forged pid
 * that names a live process duplicates it, and queryWindowsProcessesWithWmic
 * drops the snapshot on duplicate pids.
 */
function parseWindowsProcessValueRows(stdout: string): WindowsProcessRow[] {
  const rows: WindowsProcessRow[] = []
  const values: string[] = ['', '', '', '', '']
  let field = -1

  const flush = (): void => {
    const ppid = Number.parseInt(values[3]!, 10)
    const pid = Number.parseInt(values[4]!, 10)
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      const name = values[2]!.trim()
      rows.push({
        pid,
        ppid,
        name,
        command: values[0]!.trim() || name,
        executablePath: values[1]!.trim()
      })
    }
    values.fill('')
    field = -1
  }

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') {
      // Only past CommandLine does a blank line mean end-of-record; inside one it
      // is content. Agent CLIs really do embed blank lines — on this machine every
      // process whose command line held one was a claude/codex/node/sh pane, the
      // exact rows foreground detection reads. Flushing there dropped the command
      // and left the row naming only its executable.
      if (field >= 1) {
        flush()
      } else if (field === 0) {
        values[0] += '\n'
      }
      continue
    }
    const eq = line.indexOf('=')
    const next =
      eq === -1 ? -1 : (WMIC_VALUE_FIELDS as readonly string[]).indexOf(line.slice(0, eq))
    if (next >= 0 && (field === -1 || next === field + 1)) {
      field = next
      values[next] = line.slice(eq + 1)
      if (next === WMIC_VALUE_FIELDS.length - 1) {
        flush()
      }
    } else if (field >= 0) {
      values[field] += `\n${line}`
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

type WmicScan =
  /** wmic is missing, or its output is not the key=value table we can read. */
  | { status: 'unsupported' }
  /** wmic ran but this scan did not answer: a WMI hiccup, a timeout, a torn table. */
  | { status: 'failed' }
  | { status: 'ok'; rows: WindowsProcessRow[] }

/**
 * wmic writes UTF-16LE through a redirected stdout, so read bytes and pick the
 * encoding from the BOM — decoding as utf8 would yield NUL-padded keys that match
 * nothing and silently strand every machine on the PowerShell path this fixes.
 */
function decodeWmicStdout(stdout: string | Buffer): string {
  if (typeof stdout === 'string') {
    return stdout
  }
  if (stdout[0] === 0xff && stdout[1] === 0xfe) {
    return stdout.toString('utf16le', 2)
  }
  if (stdout[0] === 0xef && stdout[1] === 0xbb && stdout[2] === 0xbf) {
    return stdout.toString('utf8', 3)
  }
  // A BOM-less UTF-16LE table still pads every ASCII byte with a NUL.
  return stdout.subarray(0, 64).includes(0) ? stdout.toString('utf16le') : stdout.toString('utf8')
}

/** Whole-process-table scan via wmic — the preferred reader, see #15209. */
async function queryWindowsProcessesWithWmic(): Promise<WmicScan> {
  let stdout: string
  try {
    const result = await execFileAsync(
      WMIC_PATH,
      [
        'process',
        'get',
        'CommandLine,ExecutablePath,Name,ParentProcessId,ProcessId',
        '/format:value'
      ],
      {
        encoding: 'buffer',
        timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
        // 16MB: the cap counts raw bytes here, and UTF-16 doubles the table.
        maxBuffer: 16 * 1024 * 1024,
        // Why: same focus-stealing hazard as the powershell scan — without this,
        // each fork pops a conhost window that steals keyboard focus.
        windowsHide: true
      }
    )
    stdout = decodeWmicStdout(result.stdout)
  } catch (error) {
    // ENOENT is 24H2+, where wmic is gone for good; anything else may recover.
    const missing = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
    return { status: missing ? 'unsupported' : 'failed' }
  }
  if (stdout.trim() === '') {
    return { status: 'failed' }
  }
  const rows = parseWindowsProcessValueRows(stdout)
  if (rows.length === 0) {
    // Output arrived and parsed to nothing: this build's wmic does not speak the
    // format we read, and no later scan will change that.
    return { status: 'unsupported' }
  }
  // pids are unique in a live table, so a repeat means the record framing
  // desynced. Ancestry off a desynced table can misdirect `taskkill /T /F`.
  if (new Set(rows.map((row) => row.pid)).size !== rows.length) {
    return { status: 'failed' }
  }
  return { status: 'ok', rows }
}
