import { getDaemonRuntimeDir } from '../daemon/daemon-launch-paths'
import {
  readWindowsProcessTableFresh,
  type WindowsProcessRow
} from '../windows/windows-process-table'
import type { HostProcess } from '../../shared/perforce/workspace-copy/workspace-copy-host'

/**
 * This Orca's process tree: main, this app's terminal daemon (its command line names this app's
 * daemon folder, so another Orca install's daemon is not ours), and everything they started.
 */
export function orcaOwnedPids(rows: readonly WindowsProcessRow[], daemonDir: string): Set<number> {
  const daemonDirLower = daemonDir.toLowerCase()
  const children = new Map<number, WindowsProcessRow[]>()
  for (const row of rows) {
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row])
  }
  const owned = new Set<number>()
  const queue = rows.filter(
    (row) =>
      row.pid === process.pid ||
      (row.command.includes('daemon-entry') && row.command.toLowerCase().includes(daemonDirLower))
  )
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index]
    if (owned.has(parent.pid)) {
      continue
    }
    owned.add(parent.pid)
    for (const child of children.get(parent.pid) ?? []) {
      // Why: a ppid can name a parent that exited and whose pid was reused since.
      const reused =
        child.creationTimeMs !== undefined &&
        parent.creationTimeMs !== undefined &&
        child.creationTimeMs < parent.creationTimeMs
      if (!reused) {
        queue.push(child)
      }
    }
  }
  return owned
}

/** The process table for a Perforce copy's holder checks. */
export async function listCopyHostProcesses(): Promise<HostProcess[]> {
  const rows = await readWindowsProcessTableFresh()
  const owned = orcaOwnedPids(rows, getDaemonRuntimeDir())
  return rows.map((row) => ({
    pid: row.pid,
    name: row.name,
    commandLine: row.command,
    startedAt: row.creationTimeMs ?? null,
    parentPid: row.ppid,
    ownedByOrca: owned.has(row.pid)
  }))
}
