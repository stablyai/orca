import type { ProcessIdentityRow } from '../opencode/opencode-client-sweep'

/** pid→ppid index for one sweep; first row wins on duplicate pids. */
export function buildParentPidIndex(processes: readonly ProcessIdentityRow[]): Map<number, number> {
  const ppidByPid = new Map<number, number>()
  for (const row of processes) {
    if (!ppidByPid.has(row.pid)) {
      ppidByPid.set(row.pid, row.ppid)
    }
  }
  return ppidByPid
}

/** Nearest pane shell at or above this pid; external terminals stay unattributed. */
export function findOwningPane(
  ppidByPid: Map<number, number>,
  paneKeyByShellPid: Map<number, string>,
  pid: number
): string | null {
  const seen = new Set<number>()
  let current: number | undefined = pid
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    const owner = paneKeyByShellPid.get(current)
    if (owner) {
      return owner
    }
    current = ppidByPid.get(current)
  }
  return null
}
