import type { IPty } from 'node-pty'
import {
  getCommandTokenPathBasename,
  getFirstCommandToken
} from '../../../shared/shell/command-resolution/command-token-scanner'
import {
  collectDescendantsFromIndex,
  getProcessTableIndex
} from '../../../shared/process-observation/tables/process-table-index'
import { hasControllingTty } from '../../../shared/terminal/pty/native-process/posix-controlling-terminal'
import type { ProcessTableRow } from '../../../shared/process-observation/tables/process-table-snapshot'
import type { PtyChildProcessVerdict } from '../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { getPaneOccupancy } from '../../providers/foreground/agent-process-batch'
import { readWindowsPtyJobProcessIds } from '../../providers/foreground/windows/pty-job-membership'
import { readWindowsConsoleAttachedProcessIds } from '../../providers/foreground/windows/console-attached-processes'
import { isWindowsShellAloneInJob } from '../../providers/foreground/windows/shell-alone-in-job'
import { ptyShellProcessId } from '../../windows/windows-pty-job'
import {
  readWindowsProcessIdentityTable,
  readWindowsProcessIdentityTableFresh
} from '../../windows/windows-process-table'

export function executableName(command: string): string {
  return getCommandTokenPathBasename(getFirstCommandToken(command)).replace(/^-/, '')
}

export function inspectSpawnFileChildProcessesFromRows(
  rows: readonly ProcessTableRow[],
  rootPid: number,
  shellName: string | null,
  includeTerminalGroups = false
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
  if (tree.some((row) => !launchChain.has(row.pid) && !row.stat.includes('Z'))) {
    return 'children'
  }
  if (!includeTerminalGroups) {
    return 'no-children'
  }

  // Teardown reaches every group on this terminal, including reparented and group-only members.
  const occupancy = getPaneOccupancy(rows)
  const terminalGroups = occupancy.processGroupsByTty.get(shell.tpgid ?? 0)
  if (!terminalGroups || occupancy.processGroupsIncomplete) {
    return 'unverifiable'
  }
  const launchGroupSizes = new Map<number, number>()
  for (const pid of launchChain) {
    const pgid = index.byPid.get(pid)?.pgid
    if (pgid !== undefined) {
      launchGroupSizes.set(pgid, (launchGroupSizes.get(pgid) ?? 0) + 1)
    }
  }
  for (const pgid of terminalGroups) {
    if ((occupancy.rowsByProcessGroup.get(pgid) ?? 0) > (launchGroupSizes.get(pgid) ?? 0)) {
      return 'children'
    }
  }
  return 'no-children'
}

export async function inspectSpawnFileWindowsChildProcesses(
  proc: IPty,
  shellPath: string,
  fresh = true,
  /** Adoption only: may fork the console-list helper to set aside detached daemons. */
  ignoreDetached = false,
  jobMembershipOnly = false,
  afterMs?: number,
  signal?: AbortSignal
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
        const rows = await (fresh || afterMs !== undefined
          ? readWindowsProcessIdentityTableFresh(afterMs, signal)
          : readWindowsProcessIdentityTable())
        // Panes polling one shared snapshot share its index instead of each rescanning the table.
        const byPid = getProcessTableIndex(rows).byPid
        if ([...members].some((pid) => !byPid.get(pid)?.name)) {
          throw new Error('Incomplete shell job identity')
        }
        return rows
      },
      ignoreDetached ? () => readWindowsConsoleAttachedProcessIds(shellPid) : undefined,
      jobMembershipOnly
    )
    if (!alone) {
      return 'children'
    }
    if (afterMs !== undefined) {
      // A child can join the job while the identity table is being captured.
      const current = readWindowsPtyJobProcessIds(proc)
      if (
        !current ||
        current.size !== members.size ||
        [...members].some((pid) => !current.has(pid))
      ) {
        return 'unverifiable'
      }
    }
    return 'no-children'
  } catch {
    signal?.throwIfAborted()
    return 'unverifiable'
  }
}
