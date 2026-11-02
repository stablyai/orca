import { isGitForWindowsBashLauncherPath } from '../git-bash'
import type { WindowsProcessIdentityRow } from '../windows/windows-process-table'
import {
  buildProcessTableIndex,
  collectDescendantsFromIndex
} from '../../shared/process-table-index'

const MSYS_BASH_IMAGE = 'bash.exe'

/** Git Bash launcher/MSYS exec stubs form a live unbranched bash chain; commands add a non-bash leaf or branch.
 * Builtin-only/nested bash remains indistinguishable from idle. Optional console proof excludes detached orphans;
 * ancestry alone cannot distinguish them from live MSYS children with exited Win32 parents. */
export async function isWindowsShellAloneInJob(
  shellPid: number,
  spawnedShellPath: string,
  jobProcessIds: ReadonlySet<number> | null | undefined,
  readIdentityTable: () => Promise<WindowsProcessIdentityRow[]>,
  readConsoleAttachedProcessIds?: () => Promise<ReadonlySet<number> | null>
): Promise<boolean> {
  if (!jobProcessIds?.has(shellPid)) {
    return false
  }
  if (jobProcessIds.size === 1) {
    return true
  }
  const isLauncher = isGitForWindowsBashLauncherPath(spawnedShellPath)
  if (!isLauncher && !readConsoleAttachedProcessIds) {
    return false
  }
  const rows = (await readIdentityTable()).filter((row) => jobProcessIds.has(row.pid))
  // A member missing from the table exited or was never readable: no proof either way.
  if (rows.length !== jobProcessIds.size) {
    return false
  }
  const members = await withoutDetachedOrphans(shellPid, rows, readConsoleAttachedProcessIds)
  if (members.length === 1) {
    return true
  }
  if (!isLauncher) {
    return false
  }
  const startMsByPid = new Map(members.map((row) => [row.pid, row.creationTimeMs]))
  const visited = new Set([shellPid])
  let parentPid = shellPid
  while (visited.size < members.length) {
    const children = members.filter((row) => row.ppid === parentPid && !visited.has(row.pid))
    const child = children[0]
    if (
      children.length !== 1 ||
      child.name.toLowerCase() !== MSYS_BASH_IMAGE ||
      startedBefore(child.creationTimeMs, startMsByPid.get(parentPid))
    ) {
      return false
    }
    visited.add(child.pid)
    parentPid = child.pid
  }
  return true
}

/** Drops members that are neither linked to the shell through live parents nor on its console. */
async function withoutDetachedOrphans(
  shellPid: number,
  members: WindowsProcessIdentityRow[],
  readConsoleAttachedProcessIds: (() => Promise<ReadonlySet<number> | null>) | undefined
): Promise<WindowsProcessIdentityRow[]> {
  if (!readConsoleAttachedProcessIds) {
    return members
  }
  const linked = new Set([
    shellPid,
    ...collectDescendantsFromIndex(buildProcessTableIndex(members), shellPid).map((row) => row.pid)
  ])
  if (members.every((row) => linked.has(row.pid))) {
    return members
  }
  const attached = await readConsoleAttachedProcessIds().catch(() => null)
  return attached ? members.filter((row) => linked.has(row.pid) || attached.has(row.pid)) : members
}

/** A child older than its parent carries a reused ppid; only checkable when the snapshot has start times. */
function startedBefore(
  childStartMs: number | undefined,
  parentStartMs: number | undefined
): boolean {
  return childStartMs !== undefined && parentStartMs !== undefined && childStartMs < parentStartMs
}
