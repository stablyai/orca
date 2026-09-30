import { runProcess } from '../../shared/child-process/run-process'
import {
  readWindowsProcessTable,
  type WindowsProcessRow as NativeWindowsProcessRow
} from '../windows/windows-process-table'

/**
 * Host-wide sweep locating live OpenCode client processes for the
 * session→pane binder (#21359).
 *
 * Why a dedicated sweep instead of reusing the memory collector's: that
 * index carries pid/ppid/cpu/rss but no argv or start times, and importing
 * the memory subsystem here would drag its Electron app-metrics dependency
 * into the hook path. On Windows the table is read only through the native
 * reader (`windows-process-table.ts`); on macOS/Linux through one `ps` call.
 * The invocation pattern (5 s timeout, 10 MB cap, fail-open []) mirrors
 * `windows-process-resource-collector.ts`.
 */

/** One process identity row from a host sweep. */
export type ProcessIdentityRow = {
  pid: number
  ppid: number
  /** ms epoch the process started. */
  startedAtMs: number
  /**
   * Kernel-reported executable name (`comm=` on POSIX, `name` on Windows).
   * Unlike `args=`, this is not a reconstructed string, so an install path
   * containing spaces cannot split it. Empty when the sweep could not read it;
   * classification then falls back to argv[0].
   */
  executable: string
  /** argv approximation; see parsePsArgsLine. */
  argv: string[]
}

const SWEEP_TIMEOUT_MS = 5_000
const SWEEP_MAX_BYTES = 10 * 1024 * 1024

/** `[[dd-]hh:]mm:ss` → elapsed ms, or null when the shape is unknown. */
export function parsePsElapsedToMs(etime: string, nowMs: number): number | null {
  const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/)
  if (!match) {
    return null
  }
  const days = Number.parseInt(match[1] ?? '0', 10)
  const hours = Number.parseInt(match[2] ?? '0', 10)
  const minutes = Number.parseInt(match[3] ?? '0', 10)
  const seconds = Number.parseInt(match[4] ?? '0', 10)
  if ([days, hours, minutes, seconds].some((n) => !Number.isFinite(n) || n < 0)) {
    return null
  }
  return nowMs - ((days * 24 + hours) * 3_600 + minutes * 60 + seconds) * 1000
}

/**
 * Split a command line into argv, grouping `"..."` so a quoted executable
 * path survives as argv[0]. Covers the shapes that matter here (a quoted
 * install path plus plain flags); it is not a full shell parser — an escaped
 * quote inside a quoted span still splits. Downstream only flag-adjacent
 * values (`--session <id>`) are read from this argv; classification uses the
 * kernel executable name, because `ps` `args=` cannot preserve argv
 * boundaries for unquoted paths.
 */
export function splitCommandLineArgv(commandLine: string): string[] {
  const argv: string[] = []
  const pattern = /"([^"]*)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(commandLine)) !== null) {
    argv.push(match[1] ?? match[2] ?? '')
  }
  return argv.filter((part) => part.length > 0)
}

/**
 * One `ps -eo pid=,ppid=,etime=,args=` line. `args` is a reconstructed
 * command-and-arguments string: argv boundaries are lost, so a path with an
 * unquoted space (e.g. `/opt/Open Code/opencode`) splits argv[0] in two.
 * The executable name therefore comes from a separate `comm=` sweep;
 * this parser records the flags it can still read reliably (`--session`
 * values never contain spaces) and leaves `executable` empty for the join.
 */
export function parsePsArgsLine(line: string, nowMs: number): ProcessIdentityRow | null {
  // Why a regex instead of split-with-limit: split discards everything past
  // the limit, which would truncate argv to its first token.
  const match = line.trim().match(/^(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]*\S)\s*$/)
  if (!match) {
    return null
  }
  const [, pidText, ppidText, etimeText, argsText] = match
  if (!pidText || !ppidText || !etimeText || !argsText) {
    return null
  }
  const pid = Number.parseInt(pidText, 10)
  const ppid = Number.parseInt(ppidText, 10)
  const startedAtMs = parsePsElapsedToMs(etimeText, nowMs)
  const argv = splitCommandLineArgv(argsText)
  if (
    !Number.isFinite(pid) ||
    !Number.isFinite(ppid) ||
    startedAtMs === null ||
    argv.length === 0
  ) {
    return null
  }
  return { pid, ppid, startedAtMs, executable: '', argv }
}

/**
 * One `ps -eo pid=,comm=` line. `comm` is the kernel's executable name as a
 * trailing field, so it may itself contain spaces — everything past the pid
 * is the name. Empty names are dropped; the join then falls back to argv[0].
 */
export function parsePsCommLine(line: string): { pid: number; executable: string } | null {
  const match = line.trim().match(/^(\S+)\s+([\s\S]*\S)\s*$/)
  if (!match) {
    return null
  }
  const [, pidText, executable] = match
  const pid = Number.parseInt(pidText ?? '', 10)
  if (!Number.isFinite(pid) || !executable) {
    return null
  }
  return { pid, executable }
}

/**
 * One native Windows process-table row. Rows without a kernel creation time
 * cannot bracket a session creation, so they are skipped rather than guessed.
 */
export function nativeWindowsRowToIdentity(
  row: NativeWindowsProcessRow
): ProcessIdentityRow | null {
  if (!Number.isFinite(row.pid) || !Number.isFinite(row.ppid)) {
    return null
  }
  if (typeof row.creationTimeMs !== 'number' || !Number.isFinite(row.creationTimeMs)) {
    return null
  }
  const argv = splitCommandLineArgv(row.command)
  if (argv.length === 0) {
    return null
  }
  return {
    pid: row.pid,
    ppid: row.ppid,
    startedAtMs: row.creationTimeMs,
    executable: row.name,
    argv
  }
}

function executableBaseName(value: string): string {
  const bare = value.split(/[\\/]/).at(-1) ?? ''
  return bare.toLowerCase().replace(/\.exe$/, '')
}

function argvZeroBase(argv: readonly string[]): string {
  return executableBaseName(argv[0] ?? '')
}

/** True for an OpenCode TUI/CLI client process (not the `serve` daemon). */
export function isOpenCodeClientArgv(argv: readonly string[]): boolean {
  return isOpenCodeClientProcess({ executable: '', argv })
}

/**
 * True for an OpenCode TUI/CLI client process (not the `serve` daemon).
 * The kernel-reported executable wins when present: `ps` `args=` cannot
 * preserve argv boundaries, so a truncated argv[0] must not veto a matching
 * executable. With no executable recorded this degrades to argv[0] matching.
 */
export function isOpenCodeClientProcess(row: {
  executable: string
  argv: readonly string[]
}): boolean {
  const classified =
    row.executable && row.executable.length > 0
      ? executableBaseName(row.executable)
      : argvZeroBase(row.argv)
  if (classified !== 'opencode') {
    return false
  }
  // Why exclude: the shared server's posts are the ones being reattributed;
  // mistaking the daemon for a pane client would bind sessions to its pane.
  return !row.argv.some((part) => part === 'serve' || part === '--service')
}

/** Every process identity row on this host; fail-open [] like the memory sweeps. */
export async function sweepProcessIdentities(
  deps: {
    platform?: NodeJS.Platform
    run?: typeof runProcess
    nowMs?: number
    readWindowsTable?: () => Promise<NativeWindowsProcessRow[]>
  } = {}
): Promise<ProcessIdentityRow[]> {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? runProcess
  const nowMs = deps.nowMs ?? Date.now()
  try {
    if (platform === 'win32') {
      // Why the native table and nothing else: it is the only sanctioned
      // Windows process-table reader (see windows-process-enumeration.md);
      // forking powershell.exe for a whole-table CIM scan is exactly the
      // pattern it retired.
      const readTable = deps.readWindowsTable ?? readWindowsProcessTable
      const rows = await readTable()
      return rows
        .map((row) => nativeWindowsRowToIdentity(row))
        .filter((row): row is ProcessIdentityRow => row !== null)
    }
    const stdout = await execFileText(run, 'ps', ['-eo', 'pid=,ppid=,etime=,args='])
    const rows = stdout
      .split('\n')
      .map((line) => parsePsArgsLine(line, nowMs))
      .filter((row): row is ProcessIdentityRow => row !== null)
    // Why a second sweep: `args=` is one reconstructed string, so the
    // executable name for classification comes from `comm=` instead. A
    // failed comm sweep degrades to argv[0] matching rather than dropping
    // the whole round.
    try {
      const commOut = await execFileText(run, 'ps', ['-eo', 'pid=,comm='])
      const executables = new Map<number, string>()
      for (const line of commOut.split('\n')) {
        const parsed = parsePsCommLine(line)
        if (parsed && !executables.has(parsed.pid)) {
          executables.set(parsed.pid, parsed.executable)
        }
      }
      for (const row of rows) {
        const executable = executables.get(row.pid)
        if (executable) {
          row.executable = executable
        }
      }
    } catch (err) {
      console.warn('[opencode-binder] comm sweep failed; classifying from argv', err)
    }
    return rows
  } catch (err) {
    console.warn('[opencode-binder] process sweep failed; skipping round', err)
    return []
  }
}

/** Run one child process to text, throwing on timeout or nonzero exit. */
async function execFileText(
  run: typeof runProcess,
  program: string,
  args: string[]
): Promise<string> {
  const result = await run({
    program,
    args,
    timeoutMs: SWEEP_TIMEOUT_MS,
    maxOutputBytes: SWEEP_MAX_BYTES
  })
  if (result.timedOut || result.code !== 0) {
    throw new Error(`${program} exited ${result.code ?? 'on timeout'}`)
  }
  return result.stdout
}
