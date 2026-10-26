import type { IPty } from 'node-pty'
import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../../shared/command-token-scanner'
import {
  collectDescendantsFromIndex,
  getProcessTableIndex
} from '../../../shared/process-table-index'
import { hasControllingTty } from '../../../shared/posix-controlling-terminal'
import type { ProcessTableRow } from '../../../shared/process-table-snapshot'
import type { PtyChildProcessVerdict } from '../../../shared/terminal-process-inspection'
import { readWindowsPtyJobProcessIds } from '../../providers/windows-pty-job-membership'
import { readWindowsConsoleAttachedProcessIds } from '../../providers/windows-console-attached-processes'
import { isWindowsShellAloneInJob } from '../../providers/windows-shell-alone-in-job'
import { ptyShellProcessId } from '../../windows/windows-pty-job'
import {
  readWindowsProcessIdentityTable,
  readWindowsProcessIdentityTableFresh
} from '../../windows/windows-process-table'

function executableName(command: string): string {
  return getCommandTokenPathBasename(getFirstCommandToken(command)).replace(/^-/, '')
}

export function inspectSpawnFileChildProcessesFromRows(
  rows: readonly ProcessTableRow[],
  rootPid: number,
  shellName: string | null
): PtyChildProcessVerdict {
  const index = getProcessTableIndex(rows)
  const root = index.byPid.get(rootPid)
  if (!root || !shellName || !hasControllingTty(root.tty)) {
    return 'unverifiable'
  }
  const tree = [{ ...root, depth: 0 }, ...collectDescendantsFromIndex(index, rootPid)]
  const shell = tree
    .filter((row) => executableName(row.command) === shellName && !row.stat.includes('Z'))
    .sort((left, right) => left.depth - right.depth)[0]
  if (!shell) {
    return 'unverifiable'
  }
  // The macOS login wrapper and its spawned shell are launch plumbing, not user jobs.
  const launchChain = new Set([rootPid])
  let ancestor: ProcessTableRow | undefined = shell
  while (ancestor && !launchChain.has(ancestor.pid)) {
    launchChain.add(ancestor.pid)
    ancestor = index.byPid.get(ancestor.ppid)
  }
  return tree.some((row) => !launchChain.has(row.pid) && !row.stat.includes('Z'))
    ? 'children'
    : 'no-children'
}

export async function inspectSpawnFileWindowsChildProcesses(
  proc: IPty,
  shellPath: string,
  fresh = true,
  /** Adoption only: may fork the console-list helper to set aside detached daemons. */
  ignoreDetached = false
): Promise<PtyChildProcessVerdict> {
  try {
    const members = readWindowsPtyJobProcessIds(proc)
    const shellPid = ptyShellProcessId(proc)
    if (!shellPid || !members?.has(shellPid)) {
      return 'unverifiable'
    }
    const alone = await isWindowsShellAloneInJob(
      shellPid,
      shellPath,
      members,
      async () => {
        const rows = await (fresh
          ? readWindowsProcessIdentityTableFresh()
          : readWindowsProcessIdentityTable())
        if ([...members].some((pid) => !rows.some((row) => row.pid === pid && row.name))) {
          throw new Error('Incomplete shell job identity')
        }
        return rows
      },
      ignoreDetached ? () => readWindowsConsoleAttachedProcessIds(shellPid) : undefined
    )
    return alone ? 'no-children' : 'children'
  } catch {
    return 'unverifiable'
  }
}
