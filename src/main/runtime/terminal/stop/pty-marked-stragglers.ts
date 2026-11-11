// Every process a PTY starts inherits ORCA_PTY_SESSION_ID=<that PTY's id> (spawn-environment.ts), and keeps it
// through setsid, launcher wrappers and grandchildren. Killing the PTY's session can miss a process that left
// the session (RA-ORPH: a create-launched Claude survived its pane's Restart). After an exact stop, anything
// still carrying this PTY's id is killed by process group, and the stop only counts as verified when nothing
// with the id is left. Only exact matches of this PTY's id are touched, so a sibling pane's agent (its own
// id) is never signalled. Linux only (cloud sandboxes); elsewhere this is a no-op.
import { readdir, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

export const ORCA_PTY_SESSION_ENV = 'ORCA_PTY_SESSION_ID'

export type MarkedProcess = { pid: number; pgid: number }

export type StragglerDeps = {
  platform?: NodeJS.Platform
  selfPid?: number
  listPids?: () => Promise<number[]>
  readEnviron?: (pid: number) => Promise<string | null>
  readStat?: (pid: number) => Promise<string | null>
  signal?: (target: number, signal: NodeJS.Signals) => void
  graceMs?: number
}

const defaultListPids = async (): Promise<number[]> => {
  const names: string[] = await readdir('/proc').catch(() => [])
  return names.filter((name) => /^\d+$/.test(name)).map(Number)
}
const readOrNull = (path: string) => readFile(path, 'utf8').catch(() => null)

/** /proc/<pid>/stat's pgid (field 5, after the parenthesised command that may itself contain spaces). */
function pgidFromStat(stat: string): number | null {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const pgid = Number(fields[2])
  return Number.isInteger(pgid) && pgid > 0 ? pgid : null
}

export async function findPtyMarkedProcesses(
  ptyId: string,
  deps: StragglerDeps = {}
): Promise<MarkedProcess[]> {
  if ((deps.platform ?? process.platform) !== 'linux' || !ptyId) {
    return []
  }
  const self = deps.selfPid ?? process.pid
  const entry = `${ORCA_PTY_SESSION_ENV}=${ptyId}`
  const readEnviron = deps.readEnviron ?? ((pid: number) => readOrNull(`/proc/${pid}/environ`))
  const readStat = deps.readStat ?? ((pid: number) => readOrNull(`/proc/${pid}/stat`))
  const found: MarkedProcess[] = []
  for (const pid of await (deps.listPids ?? defaultListPids)()) {
    if (pid === self || pid <= 1) {
      continue
    }
    const environ = await readEnviron(pid)
    // Exact entry only: another PTY's id that merely starts with this one never matches.
    if (!environ || !environ.split('\0').includes(entry)) {
      continue
    }
    const stat = await readStat(pid)
    const pgid = stat ? pgidFromStat(stat) : null
    if (pgid !== null) {
      found.push({ pid, pgid })
    }
  }
  return found
}

/**
 * Kills whatever still carries this PTY's id and returns the pids that survived the grace period (empty
 * when none). A process group is signalled only when its leader is itself one of the marked processes.
 */
export async function killPtyStragglers(
  ptyId: string,
  deps: StragglerDeps = {}
): Promise<number[]> {
  const marked = await findPtyMarkedProcesses(ptyId, deps)
  if (marked.length === 0) {
    return []
  }
  const signal = deps.signal ?? ((target: number, sig: NodeJS.Signals) => process.kill(target, sig))
  const markedPids = new Set(marked.map((entry) => entry.pid))
  for (const { pid, pgid } of marked) {
    try {
      // The whole group only when its leader is ours; otherwise just this process.
      signal(
        markedPids.has(pgid) && pgid !== (deps.selfPid ?? process.pid) ? -pgid : pid,
        'SIGKILL'
      )
    } catch {
      try {
        signal(pid, 'SIGKILL')
      } catch {}
    }
  }
  const deadline = Date.now() + (deps.graceMs ?? 2_000)
  for (;;) {
    const left = await findPtyMarkedProcesses(ptyId, deps)
    if (left.length === 0 || Date.now() >= deadline) {
      return left.map((entry) => entry.pid)
    }
    await delay(100)
  }
}
