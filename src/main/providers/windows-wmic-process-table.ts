// The wmic side of the Windows process-table read (#15209): same Win32_Process
// table, no PowerShell host, so the daemon's ~2x/s foreground scan stops writing a
// transcript file per scan under the enterprise transcription GPO.
//
// `/format:value` has no escaping and CommandLine is whatever a process was
// launched with, so everything here is built around the fact that this table is
// partly attacker-controlled: the parser refuses ambiguous framing rather than
// guessing, and callers that gate `taskkill /T /F` read the JSON path instead.
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
 * Returns null when the framing is provably compromised, which drops the whole
 * snapshot to PowerShell. Only CommandLine can hold a newline, so a continuation
 * line arriving while a later property is open means some earlier line was
 * absorbed that should not have been. A command line carrying
 * `ExecutablePath=`/`Name=`/`ParentProcessId=` in order otherwise walks the parser
 * to ParentProcessId and lets the record's own real `ProcessId=` close it —
 * re-parenting a live pid under a forged parent, with no duplicate pid to catch
 * it. Ancestry read off that feeds `taskkill /T /F`, so an ambiguous table is
 * refused rather than guessed at.
 */
function parseWindowsProcessValueRows(stdout: string): WindowsProcessRow[] | null {
  const rows: WindowsProcessRow[] = []
  const values: string[] = ['', '', '', '', '']
  let field = -1
  let expectRecordBreak = false

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
      expectRecordBreak = false
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
    // wmic closes every record with an empty line. Content resuming without one
    // means the record just flushed was supplied by a command line rather than by
    // wmic: the forger's own real properties follow immediately. Such a row can be
    // pure invention — and an invented pid is not inert, because it can bridge a
    // real orphan to our own pid and make an unrelated tree look like ours.
    if (expectRecordBreak) {
      return null
    }
    const eq = line.indexOf('=')
    const next =
      eq === -1 ? -1 : (WMIC_VALUE_FIELDS as readonly string[]).indexOf(line.slice(0, eq))
    if (field === -1) {
      if (next === 0) {
        field = 0
        values[0] = line.slice(eq + 1)
      } else if (next > 0) {
        // wmic emits every requested property, empty when NULL, so a record always
        // opens on CommandLine. One opening later means the properties before it
        // were eaten by the previous record — which is what a command line that
        // supplied its own record leaves behind, blank-line separator included.
        return null
      }
      // Anything else here is preamble, e.g. wmic's deprecation notice.
      continue
    }
    if (next === field + 1) {
      field = next
      values[next] = line.slice(eq + 1)
      if (next === WMIC_VALUE_FIELDS.length - 1) {
        flush()
        expectRecordBreak = true
      }
    } else if (field > 0) {
      return null
    } else {
      values[0] += `\n${line}`
    }
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
  if (rows === null) {
    // Framing compromised by command-line content, not a format we cannot read:
    // transient, because it lasts only as long as the process that wrote it.
    return { status: 'failed' }
  }
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
