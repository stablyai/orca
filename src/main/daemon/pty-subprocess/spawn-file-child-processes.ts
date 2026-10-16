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
import { isWindowsShellAloneInJob } from '../../providers/windows-shell-alone-in-job'
import { ptyShellProcessId } from '../../windows/windows-pty-job'
import { readWindowsProcessIdentityTableFresh } from '../../windows/windows-process-table'

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

export async function inspectSpawnFileWindowsChildProcesses(proc: IPty, shellPath: string): Promise<PtyChildProcessVerdict> {
  try {
    const members = readWindowsPtyJobProcessIds(proc)
    const shellPid = ptyShellProcessId(proc)
    if (!shellPid || !members?.has(shellPid)) {
      return 'unverifiable'
    }
    const alone = await isWindowsShellAloneInJob(shellPid, shellPath, members, async () => {
      const rows = await readWindowsProcessIdentityTableFresh()
      if ([...members].some((pid) => !rows.some((row) => row.pid === pid && row.name))) {
        throw new Error('Incomplete shell job identity')
      }
      return rows
    })
    return alone ? 'no-children' : 'children'
  } catch {
    return 'unverifiable'
  }
}
