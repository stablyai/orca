// The wmic side of the Windows process-table read (#15209): same Win32_Process
// table, no PowerShell host, so the daemon's ~2x/s foreground scan stops writing a
// transcript file per scan under the enterprise transcription GPO.
//
// `/format:value` has no escaping and CommandLine is whatever a process was
// launched with, so everything here is built around the fact that this table is
// partly attacker-controlled. Two rules follow. Bad framing costs one record, never
// the table — voiding a snapshot over content would let any process spend a
// PowerShell host and turn the flood back on. And because a command line can still
// emit a whole well-formed record that no parser can detect, callers gating
// `taskkill /T /F` read the JSON path instead of this one.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { WindowsProcessRow } from './windows-foreground-process-rows'

const execFileAsync = promisify(execFile)
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 3_000

const WMIC_SCAN_FAILURE_LIMIT = 3
// Why a cooldown and not a permanent demotion: a scan can fail because some
// process's command line walked the record framing, and that is content anyone
// on the box can arrange. Retiring wmic for the daemon's lifetime over it would
// hand any local process a switch for turning the transcript flood back on.
// Backing off instead caps the cost of a bad table at one extra spawn per
// window, and recovers on its own once the process responsible exits.
const WMIC_RETRY_BACKOFF_MS = 60_000
// Why the absolute path and not `wmic`: a bare name resolves through PATH, and on
// 24H2+ no legitimate wmic exists — so any `wmic.exe` a PATH entry offers there is
// by definition not the system one. The daemon runs this ~2x/s and targets
// `taskkill /T /F` off its output, so it reads only the one canonical location.
const WMIC_PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\wbem\\wmic.exe`
let wmicUnsupported = false
let wmicRetryAfterMs = 0
let wmicScanFailures = 0

/** Test-only: forget which reader a previous case steered this one into. */
export function resetWmicProcessTableReaderForTests(): void {
  wmicUnsupported = false
  wmicRetryAfterMs = 0
  wmicScanFailures = 0
}

/**
 * wmic rows, or null to let PowerShell answer this scan.
 *
 * Why decide from the scan rather than probing `wmic /?`: a probe proves the
 * binary exists, not that we can read its table, and the answer to both is the
 * same — stop spending a wmic spawn per scan on top of the PowerShell one.
 *
 * The two ways to stop differ in kind. `unsupported` — no binary, or output in a
 * shape we cannot read — is a property of the host and never changes, so it
 * retires wmic outright. `failed` is a property of the moment (a WMI hiccup, or a
 * command line that walked the record framing), so it only backs off, and a run
 * of them costs one extra spawn per backoff window instead of the fix.
 */
export async function readWindowsProcessRowsWithWmic(): Promise<WindowsProcessRow[] | null> {
  if (wmicUnsupported || Date.now() < wmicRetryAfterMs) {
    return null
  }
  const scan = await queryWindowsProcessesWithWmic()
  if (scan.status === 'ok') {
    wmicScanFailures = 0
    return scan.rows
  }
  if (scan.status === 'unsupported') {
    wmicUnsupported = true
    return null
  }
  wmicScanFailures += 1
  if (wmicScanFailures >= WMIC_SCAN_FAILURE_LIMIT) {
    wmicScanFailures = 0
    wmicRetryAfterMs = Date.now() + WMIC_RETRY_BACKOFF_MS
  }
  return null
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
 * A record must open on CommandLine — wmic emits every requested property, empty
 * when NULL — and a record missing a middle property merges into the next rather
 * than desyncing the rest of the table.
 *
 * A record opens only on CommandLine, and a record whose framing does not hold up
 * is dropped on its own rather than voiding the table. Both matter because a
 * command line carrying `ExecutablePath=`/`Name=`/`ParentProcessId=` in order
 * otherwise walks the parser to ParentProcessId and lets the record's own real
 * `ProcessId=` close it, re-parenting a live pid under a forged parent.
 *
 * What this cannot do is stop a command line from emitting a whole well-formed
 * record — forged properties, blank-line separator, and a `CommandLine=` to
 * resynchronise. Nothing in the byte stream tells that apart from a record wmic
 * wrote. That is why callers gating `taskkill /T /F` read the JSON path instead,
 * and why an invented row here can only misname a pane.
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
    // Exactly empty, not merely blank: a whitespace-only line is content, and
    // treating it as the separator silently ate its spaces out of the command.
    if (line === '') {
      // Only past CommandLine does an empty line mean end-of-record; inside one it
      // is content. Agent CLIs really do embed blank lines: on a measured
      // 920-process host all 11 that did were claude/codex/node/sh panes — the
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
    if (field === -1) {
      // Between records only CommandLine opens one. Anything else is the tail of a
      // record that a command line supplied for itself, a property wmic omitted, or
      // its deprecation notice — drop the line and wait for the next record rather
      // than reading a row out of it.
      if (next === 0) {
        field = 0
        values[0] = line.slice(eq + 1)
      }
      continue
    }
    if (next === field + 1) {
      field = next
      values[next] = line.slice(eq + 1)
      if (next === WMIC_VALUE_FIELDS.length - 1) {
        flush()
      }
      continue
    }
    if (field > 0) {
      // A later property is open and this is not the one that follows it, so an
      // earlier line was absorbed that should not have been. Drop this record and
      // resync — never the whole table. That framing is content any process on the
      // box can arrange, and refusing the snapshot would spend a PowerShell host on
      // it, which is the flood this file exists to stop.
      values.fill('')
      field = -1
      continue
    }
    values[0] += `\n${line}`
  }
  flush()
  return rows
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

/**
 * pids are unique in a live table, so a repeat means one of the two rows was
 * supplied by a command line claiming another process's pid. Which one is which is
 * not knowable from the bytes, so neither is kept: a pid that vanishes degrades to
 * the node-pty name, where a pid kept under the wrong parent would put an agent on
 * the wrong pane.
 */
function dropAmbiguousPids(rows: WindowsProcessRow[]): WindowsProcessRow[] {
  const seen = new Map<number, number>()
  for (const row of rows) {
    seen.set(row.pid, (seen.get(row.pid) ?? 0) + 1)
  }
  return seen.size === rows.length ? rows : rows.filter((row) => seen.get(row.pid) === 1)
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
  const rows = dropAmbiguousPids(parseWindowsProcessValueRows(stdout))
  if (rows.length === 0) {
    // Output arrived and parsed to nothing: this build's wmic does not speak the
    // format we read, and no later scan will change that.
    return { status: 'unsupported' }
  }
  return { status: 'ok', rows }
}
