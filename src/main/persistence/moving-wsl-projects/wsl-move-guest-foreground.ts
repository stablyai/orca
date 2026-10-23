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
  /** Arguments in /proc/<pid>/cmdline: an interactive shell has one, a script or `-c` more. */
  argc: number
  paneKey: string | null
  comm: string
}

/**
 * One line per process: pid, ppid, sid, argc, comm and the pane key, tab-separated. Fields come
 * after the last `)` of /proc/<pid>/stat because comm may hold spaces or parens. POSIX sh and
 * BusyBox tools only.
 */
export const WSL_GUEST_PANE_PROCESS_SCRIPT = [
  'for d in /proc/[0-9]*; do',
  '  p=${d#/proc/}',
  '  s=$(cat "$d/stat" 2>/dev/null) || continue',
  '  r=${s##*) }',
  '  set -- $r',
  '  c=$(cat "$d/comm" 2>/dev/null)',
  `  n=$(tr '\\0' '\\n' < "$d/cmdline" 2>/dev/null | wc -l)`,
  `  k=$(tr '\\0' '\\n' < "$d/environ" 2>/dev/null | sed -n 's/^ORCA_PANE_KEY=//p' | head -n 1)`,
  `  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$p" "$2" "$4" "$n" "$c" "$k"`,
  'done'
].join('\n')

export function parseWslGuestPaneProcesses(stdout: string): WslGuestProcessRow[] {
  const rows: WslGuestProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const [pid, ppid, sid, argc, comm, paneKey] = line.split('\t')
    const numbers = [pid, ppid, sid, argc].map((value) => Number(value?.trim()))
    if (comm === undefined || numbers.some((value) => !Number.isInteger(value))) {
      continue
    }
    rows.push({
      pid: numbers[0],
      ppid: numbers[1],
      sid: numbers[2],
      argc: numbers[3],
      comm: comm.trim(),
      paneKey: paneKey?.trim() || null
    })
  }
  return rows
}

/** A pane whose shell cannot be found is unverifiable, never idle. */
export function classifyWslGuestPaneForeground(
  rows: readonly WslGuestProcessRow[],
  paneKey: string
): WslGuestPaneForeground {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const tagged = rows.filter((row) => row.paneKey === paneKey)
  // The pane's shell: the topmost tagged shell. The WSL relay above it may carry the key too, so
  // tagged non-shell ancestors don't hide it.
  const shells = tagged.filter(
    (row) => isShellProcess(row.comm) && !hasTaggedShellAncestor(row, paneKey, byPid)
  )
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
  const busy = [...members.values()].filter((row) => !isShellProcess(row.comm) || row.argc > 1)
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
