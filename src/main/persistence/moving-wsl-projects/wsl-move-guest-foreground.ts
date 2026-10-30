/**
 * What a bridge WSL pane is running, read inside its distro. On Windows the pane's own process is
 * `wsl.exe`, which every live pane has, so the host process table cannot tell an idle shell from a
 * running program. Each guest process of a pane inherits `ORCA_PANE_KEY`.
 *
 * Idle means the pane's shell has nothing else: no foreground program, no background job (`&`,
 * `nohup`, `disown`), no daemon it started (`setsid` keeps the key), and no script it runs (a waiting
 * `read` is still a script). The move's Sleep ends all of those, so any of them blocks.
 */
import { recognizeAgentProcess } from '../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../shared/shell-process-detection'

/**
 * `agent`: the shell's one foreground job is an agent CLI and everything else running is its own
 * subtree, so its hook status decides; Windows sees only `wsl.exe` and could never say so.
 */
export type WslGuestPaneForeground =
  | 'shell-idle'
  | 'process-running'
  | 'unverifiable'
  | { agent: string }

export type WslGuestProcessRow = {
  pid: number
  ppid: number
  /** Session id. */
  sid: number
  /**
   * Arguments in /proc/<pid>/cmdline: an interactive shell has one, a script or `-c` more. Read
   * for pane processes only; null for the rest, which a shell then counts as busy.
   */
  argc: number | null
  paneKey: string | null
  comm: string
  /** The process's working directory, from /proc/<pid>/cwd; read for pane processes only. */
  cwd?: string
}

const BEGIN = 'ORCA_PROCESS_TABLE_BEGIN'
const TAGGED = 'ORCA_PROCESS_TABLE_TAGGED'
const END = 'ORCA_PROCESS_TABLE_END'

/**
 * Every process's /proc/<pid>/stat in one `cat`, then the pane key, argc and cwd of the Orca pane
 * processes one `grep` over every environ finds. Untagged processes stay in the table, so a job
 * started without the key (`env -i`) still keeps its pane busy; the per-process work follows the
 * pane processes, not the distro's process count. POSIX sh and BusyBox tools only.
 */
export const WSL_GUEST_PANE_PROCESS_SCRIPT = [
  `echo ${BEGIN}`,
  'cat /proc/[0-9]*/stat 2>/dev/null',
  `echo ${TAGGED}`,
  "for e in $(grep -l -s 'ORCA_PANE_KEY=' /proc/[0-9]*/environ); do",
  '  d=${e%/environ}',
  `  k=$(tr '\\0' '\\n' < "$e" 2>/dev/null | sed -n 's/^ORCA_PANE_KEY=//p' | head -n 1)`,
  `  n=$(tr '\\0' '\\n' < "$d/cmdline" 2>/dev/null | wc -l)`,
  '  w=$(readlink "$d/cwd" 2>/dev/null)',
  `  printf '%s\\t%s\\t%s\\t%s\\n' "\${d#/proc/}" "$n" "$k" "$w"`,
  'done',
  `echo ${END}`
].join('\n')

/** The table between its fences; null unless all three are there, so a cut-off table never counts. */
export function parseWslGuestPaneProcesses(stdout: string): WslGuestProcessRow[] | null {
  const lines = stdout.split('\n').map((line) => line.replace(/\r$/, ''))
  const begin = lines.indexOf(BEGIN)
  const tagged = lines.indexOf(TAGGED)
  const end = lines.lastIndexOf(END)
  if (begin === -1 || tagged <= begin || end <= tagged) {
    return null
  }
  const rows = new Map<number, WslGuestProcessRow>()
  for (const line of lines.slice(begin + 1, tagged)) {
    // comm may hold spaces and parens; the fields after it start past its last `)`.
    const open = line.indexOf(' (')
    const close = line.lastIndexOf(')')
    const pid = Number(line.slice(0, open))
    const [, ppid, , sid] = line
      .slice(close + 2)
      .split(' ')
      .map(Number)
    if (open <= 0 || close < open || ![pid, ppid, sid].every(Number.isInteger)) {
      continue
    }
    const comm = line.slice(open + 2, close)
    rows.set(pid, { pid, ppid, sid, argc: null, paneKey: null, comm })
  }
  for (const line of lines.slice(tagged + 1, end)) {
    // The cwd is last and may itself hold a tab.
    const [pid, argc, paneKey, ...cwd] = line.split('\t')
    const row = rows.get(Number(pid))
    if (!row || paneKey === undefined) {
      continue
    }
    const folder = cwd.join('\t')
    rows.set(row.pid, {
      ...row,
      argc: Number.isInteger(Number(argc?.trim())) ? Number(argc.trim()) : null,
      paneKey: paneKey.trim() || null,
      ...(readableCwd(folder) ? { cwd: folder } : {})
    })
  }
  return [...rows.values()]
}

/** A pane whose shell cannot be found is unverifiable, never idle. */
export function classifyWslGuestPaneForeground(
  rows: readonly WslGuestProcessRow[],
  paneKey: string
): WslGuestPaneForeground {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const shells = paneShells(rows, paneKey, byPid)
  if (shells.length !== 1) {
    // None, or a second root (a tagged daemon that is itself a shell): never read as idle.
    return shells.length === 0 ? 'unverifiable' : 'process-running'
  }
  const [shell] = shells
  const ancestors = new Set<number>()
  for (let row = byPid.get(shell.ppid); row && !ancestors.has(row.pid); row = byPid.get(row.ppid)) {
    ancestors.add(row.pid)
  }
  const members = new Map<number, WslGuestProcessRow>()
  for (const row of rows) {
    if (row.pid === shell.pid || ancestors.has(row.pid)) {
      continue
    }
    if (row.paneKey === paneKey || row.sid === shell.sid || descendsFrom(row, shell.pid, byPid)) {
      members.set(row.pid, row)
    }
  }
  // A shell whose arguments were not read may be running a script: never idle.
  const busy = [...members.values()].filter(
    (row) => !isShellProcess(row.comm) || (row.argc ?? 2) > 1
  )
  if (busy.length === 0) {
    return 'shell-idle'
  }
  const agents = busy.flatMap((row) => {
    const agent = row.ppid === shell.pid ? recognizeAgentProcess(row.comm)?.agent : undefined
    return agent ? [{ pid: row.pid, agent }] : []
  })
  // A job beside the agent (`&`, nohup, a daemon it left behind) still dies with the Sleep.
  if (
    agents.length === 1 &&
    busy.every((row) => row.pid === agents[0].pid || descendsFrom(row, agents[0].pid, byPid))
  ) {
    return { agent: agents[0].agent }
  }
  return 'process-running'
}

/** The folder the pane's shell is in; null unless exactly one shell owns the pane. */
export function readWslGuestPaneShellCwd(
  rows: readonly WslGuestProcessRow[],
  paneKey: string
): string | null {
  const shells = paneShells(rows, paneKey, new Map(rows.map((row) => [row.pid, row])))
  return shells.length === 1 ? (shells[0].cwd ?? null) : null
}

// The pane's shell: the topmost tagged shell. The WSL relay above it may carry the key too, so
// tagged non-shell ancestors don't hide it.
function paneShells(
  rows: readonly WslGuestProcessRow[],
  paneKey: string,
  byPid: ReadonlyMap<number, WslGuestProcessRow>
): WslGuestProcessRow[] {
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

function descendsFrom(
  row: WslGuestProcessRow,
  ancestorPid: number,
  byPid: ReadonlyMap<number, WslGuestProcessRow>
): boolean {
  const seen = new Set<number>()
  for (let current = byPid.get(row.ppid); current; current = byPid.get(current.ppid)) {
    if (current.pid === ancestorPid) {
      return true
    }
    if (seen.has(current.pid)) {
      return false
    }
    seen.add(current.pid)
  }
  return false
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
