import { isGitForWindowsBashLauncherPath } from '../../../pty/shell-startup/git-bash'
import type { WindowsProcessIdentityRow } from '../../../windows/windows-process-table'
import {
  buildProcessTableIndex,
  collectDescendantsFromIndex,
  getProcessTableIndex
} from '../../../../shared/process-observation/tables/process-table-index'

const MSYS_BASH_IMAGE = 'bash.exe'
const WSL_IMAGE = 'wsl.exe'

/** Git Bash launcher/MSYS exec stubs form a live unbranched bash chain; commands add a non-bash leaf or branch.
 * Builtin-only/nested bash remains indistinguishable from idle. Optional console proof excludes detached orphans;
 * ancestry alone cannot distinguish them from live MSYS children with exited Win32 parents.
 * A shell-only job still needs the parent tree: a Store (MSIX) shell's children start outside its job. */
export async function isWindowsShellAloneInJob(
  shellPid: number,
  spawnedShellPath: string,
  jobProcessIds: ReadonlySet<number> | null | undefined,
  readIdentityTable: () => Promise<WindowsProcessIdentityRow[]>,
  readConsoleAttachedProcessIds?: () => Promise<ReadonlySet<number> | null>,
  /** Skips the table read for a shell-only job, missing a Store shell's escaped children. */
  jobMembershipOnly = false
): Promise<boolean> {
  if (!jobProcessIds?.has(shellPid)) {
    return false
  }
  if (jobProcessIds.size === 1) {
    return jobMembershipOnly || !hasLiveDescendant(shellPid, await readIdentityTable())
  }
  const isLauncher = isGitForWindowsBashLauncherPath(spawnedShellPath)
  if (!isLauncher && !readConsoleAttachedProcessIds) {
    return false
  }
  const index = getProcessTableIndex(await readIdentityTable())
  const rows = [...jobProcessIds].flatMap((pid) => {
    const row = index.byPid.get(pid)
    return row ? [row] : []
  })
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

/** Fails closed when the table cannot show the shell; a child older than the shell carries a reused ppid.
 * One live direct child proves work, so the walk stops there. */
function hasLiveDescendant(shellPid: number, rows: readonly WindowsProcessIdentityRow[]): boolean {
  const index = getProcessTableIndex(rows)
  const shell = index.byPid.get(shellPid)
  const shellName = shell?.name.toLowerCase()
  if (!shell || !shellName) {
    return true
  }
  // An idle wsl.exe always keeps its own helpers (inner wsl.exe, wslhost.exe, conhost.exe); the guest owns WSL work.
  if (shellName === WSL_IMAGE) {
    return false
  }
  return (index.childrenByPpid.get(shellPid) ?? []).some(
    (child) => child.pid !== shellPid && !startedBefore(child.creationTimeMs, shell.creationTimeMs)
  )
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
