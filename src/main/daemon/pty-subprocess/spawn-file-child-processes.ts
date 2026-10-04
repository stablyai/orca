import type { IPty } from 'node-pty'
import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../../shared/command-token-scanner'
import {
  collectDescendantsFromIndex,
  getProcessTableIndex
} from '../../../shared/process-table-index'
import type { ProcessTableRow } from '../../../shared/process-table-snapshot'
import type { PtyChildProcessVerdict } from '../../../shared/terminal-process-inspection'
import { readWindowsPtyJobProcessIds } from '../../providers/windows-pty-job-membership'

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
  if (!root || !shellName || !root.tty || root.tty === '?') {
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

export function inspectSpawnFileWindowsChildProcesses(proc: IPty): PtyChildProcessVerdict {
  const members = readWindowsPtyJobProcessIds(proc)
  return members === null ? 'unverifiable' : members.size > 1 ? 'children' : 'no-children'
}
