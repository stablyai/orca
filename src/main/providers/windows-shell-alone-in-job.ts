import { isGitForWindowsBashLauncherPath } from '../git-bash'
import type { WindowsProcessIdentityRow } from '../windows/windows-process-table'

const MSYS_BASH_IMAGE = 'bash.exe'

/**
 * Whether a pane's job holds only its shell: the shell pid alone, or, for Git
 * for Windows' `bin\bash.exe` launcher, one unbranched chain of MSYS bash
 * processes below it.
 *
 * The launcher hands off to `usr\bin\bash.exe` and waits, and every MSYS `exec`
 * (Orca's `chcp.com ...; exec "$BASH" ... -i` startup) leaves the pre-exec
 * process alive as a stub waiting on its successor. So an idle prompt is
 * `launcher -> bash -> ... -> bash`, the leaf being the interactive shell. A
 * command at the prompt adds a non-bash leaf, and a background job branches.
 *
 * Residual: a foreground bash running only builtins (a nested `bash`, a
 * subshell loop, a fork caught before its exec) is also a bash leaf, so it reads
 * as a shell at a prompt.
 */
export async function isWindowsShellAloneInJob(
  shellPid: number,
  spawnedShellPath: string,
  jobProcessIds: ReadonlySet<number> | null | undefined,
  readIdentityTable: () => Promise<WindowsProcessIdentityRow[]>
): Promise<boolean> {
  if (!jobProcessIds?.has(shellPid)) {
    return false
  }
  if (jobProcessIds.size === 1) {
    return true
  }
  if (!isGitForWindowsBashLauncherPath(spawnedShellPath)) {
    return false
  }
  const members = (await readIdentityTable()).filter((row) => jobProcessIds.has(row.pid))
  // A member missing from the table exited or was never readable: no proof either way.
  if (members.length !== jobProcessIds.size) {
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

/** A child older than its parent carries a reused ppid; only checkable when the snapshot has start times. */
function startedBefore(
  childStartMs: number | undefined,
  parentStartMs: number | undefined
): boolean {
  return childStartMs !== undefined && parentStartMs !== undefined && childStartMs < parentStartMs
}
