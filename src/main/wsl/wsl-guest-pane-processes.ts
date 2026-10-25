/**
 * The Orca pane processes of a running distro with their pane key and folder, read inside it.
 * On Windows a bridge WSL pane's own process is `wsl.exe`, and bash there reports no folder
 * (no OSC 7), so this is the only place a pane's shell folder can be learned. Each guest process
 * of a pane inherits `ORCA_PANE_KEY`.
 */
import { isShellProcess } from '../../shared/shell-process-detection'
import { isWslDistroRunning } from '../wsl-background-distro-gate'
import { peekConfirmedRunningWslDistros } from '../wsl-running-distro-cache'
import { runWslProcess } from './wsl-runner'

export type WslGuestProcessRow = {
  pid: number
  ppid: number
  paneKey: string | null
  comm: string
  /** The process's working directory, from /proc/<pid>/cwd; absent when it could not be read. */
  cwd?: string
}

const BEGIN = 'ORCA_PANE_PROCESSES_BEGIN'
const END = 'ORCA_PANE_PROCESSES_END'

/**
 * One line per Orca pane process between two fence lines: pid, ppid, comm, the pane key and the
 * cwd, tab-separated. One `grep` over every environ finds the tagged processes, so
 * the cost follows the panes, not the distro's process count. Fields come after the last `)` of
 * /proc/<pid>/stat because comm may hold spaces or parens. POSIX sh and BusyBox tools only.
 */
export const WSL_GUEST_PANE_PROCESS_SCRIPT = [
  `echo ${BEGIN}`,
  "for e in $(grep -l -s 'ORCA_PANE_KEY=' /proc/[0-9]*/environ); do",
  '  d=${e%/environ}',
  '  p=${d#/proc/}',
  '  s=$(cat "$d/stat" 2>/dev/null) || continue',
  '  r=${s##*) }',
  '  set -- $r',
  '  c=$(cat "$d/comm" 2>/dev/null)',
  `  k=$(tr '\\0' '\\n' < "$e" 2>/dev/null | sed -n 's/^ORCA_PANE_KEY=//p' | head -n 1)`,
  '  w=$(readlink "$d/cwd" 2>/dev/null)',
  `  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$p" "$2" "$c" "$k" "$w"`,
  'done',
  `echo ${END}`
].join('\n')

/** The rows between the fences; null unless both fences are there, so a cut-off list never counts. */
export function parseWslGuestPaneProcesses(stdout: string): WslGuestProcessRow[] | null {
  const lines = stdout.split('\n').map((line) => line.replace(/\r$/, ''))
  const begin = lines.indexOf(BEGIN)
  const end = lines.lastIndexOf(END)
  if (begin === -1 || end <= begin) {
    return null
  }
  const rows: WslGuestProcessRow[] = []
  for (const line of lines.slice(begin + 1, end)) {
    // The cwd is last and may itself hold a tab.
    const [pid, ppid, comm, paneKey, ...cwd] = line.split('\t')
    const numbers = [pid, ppid].map((value) => Number(value?.trim()))
    if (comm === undefined || numbers.some((value) => !Number.isInteger(value))) {
      continue
    }
    rows.push({
      pid: numbers[0],
      ppid: numbers[1],
      comm: comm.trim(),
      paneKey: paneKey?.trim() || null,
      ...(readableCwd(cwd.join('\t')) ? { cwd: cwd.join('\t') } : {})
    })
  }
  return rows
}

const readsInFlight = new Map<string, Promise<WslGuestProcessRow[] | null>>()

/**
 * The distro's process rows; null when it is not running (a read would boot it) or could not be
 * read in full. Callers asking at once, such as the panes of one Sleep, share one read.
 */
export function readWslGuestPaneProcesses(
  distro: string,
  timeoutMs: number,
  /** The caller has a live process in the distro, so it is running and needs no check. */
  opts: { running?: boolean } = {}
): Promise<WslGuestProcessRow[] | null> {
  // WSL resolves distro names case-insensitively.
  const key = distro.toLowerCase()
  const inFlight = readsInFlight.get(key)
  if (inFlight) {
    return inFlight
  }
  const read = (async () => {
    // Why the confirmed list too: a session the client holds as live may sit in a distro that was
    // terminated since, and reading it would boot it.
    const knownRunning =
      opts.running === true &&
      (peekConfirmedRunningWslDistros() ?? []).some((running) => running.toLowerCase() === key)
    if (!knownRunning && !(await isWslDistroRunning(distro))) {
      return null
    }
    const result = await runWslProcess({
      distro,
      script: WSL_GUEST_PANE_PROCESS_SCRIPT,
      loginPath: 'none',
      timeoutMs,
      maxOutputBytes: 1_048_576
    })
    return result.code !== 0 || result.timedOut || result.outputTruncated
      ? null
      : parseWslGuestPaneProcesses(result.stdout)
  })()
    .catch(() => null)
    .finally(() => readsInFlight.delete(key))
  readsInFlight.set(key, read)
  return read
}

/** The folder the pane's shell is in; null unless exactly one shell owns the pane. */
export function readWslGuestPaneShellCwd(
  rows: readonly WslGuestProcessRow[],
  paneKey: string
): string | null {
  const shells = paneShells(rows, paneKey)
  return shells.length === 1 ? (shells[0].cwd ?? null) : null
}

/**
 * The pane's shell: the topmost tagged shell. The WSL relay above it may carry the key too, so
 * tagged non-shell ancestors don't hide it.
 */
export function paneShells(
  rows: readonly WslGuestProcessRow[],
  paneKey: string
): WslGuestProcessRow[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  return rows.filter(
    (row) =>
      row.paneKey === paneKey &&
      isShellProcess(row.comm) &&
      !hasTaggedShellAncestor(row, paneKey, byPid)
  )
}

// A removed folder reads back as `<path> (deleted)`, which no shell can return to.
function readableCwd(cwd: string): boolean {
  return cwd.startsWith('/') && !cwd.endsWith(' (deleted)')
}

function hasTaggedShellAncestor(
  row: WslGuestProcessRow,
  paneKey: string,
  byPid: ReadonlyMap<number, WslGuestProcessRow>
): boolean {
  const seen = new Set<number>()
  for (let current = byPid.get(row.ppid); current; current = byPid.get(current.ppid)) {
    if (seen.has(current.pid)) {
      return false
    }
    seen.add(current.pid)
    if (current.paneKey === paneKey && isShellProcess(current.comm)) {
      return true
    }
  }
  return false
}
