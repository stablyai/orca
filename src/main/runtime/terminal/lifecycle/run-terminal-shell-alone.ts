/** Read execution-host process tables: daemon shell-ownership changes only after full-screen exit and misses plain failed/finished commands. Observation failure is unproven. */
import {
  commandExecutable,
  confirmShellForegroundProcess,
  type ShellForegroundConfirmationOptions
} from '../../../providers/foreground/agent-process'
import { getFreshShellForegroundSnapshot } from '../../../../shared/process-observation/tables/process-table-snapshot-reader'
import {
  collectDescendantsFromIndex,
  getProcessTableIndex
} from '../../../../shared/process-observation/tables/process-table-index'
import { recognizeAgentProcessFromCommandLine } from '../../../../shared/agent-status/process/agent-process-recognition'
import { isShellProcess } from '../../../../shared/agent-status/process/shell-process-detection'
import type { TerminalProcessInspection } from '../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'

/** Only a stopped job running the pane's agent (any agent when unknown) keeps its exit unproven;
 *  a stopped editor or another agent suspended before it does not. */
export function stoppedAgentBlocks(agent?: string): (row: { command: string }) => boolean {
  return (row) => {
    const recognized = recognizeAgentProcessFromCommandLine(row.command)
    return recognized !== null && (!agent || recognized.agent === agent)
  }
}

/** POSIX: the PTY's shell owns the terminal's foreground group and nothing under it is stopped. */
export async function confirmRootShellAloneFromProcessTable(
  rootPid: number,
  options?: Pick<ShellForegroundConfirmationOptions, 'stoppedJobBlocks'>
): Promise<boolean> {
  try {
    const processIndex = getProcessTableIndex(await getFreshShellForegroundSnapshot())
    const root = processIndex.byPid.get(rootPid)
    if (!root) {
      return false
    }
    // macOS roots each PTY at /usr/bin/login, with the login shell beneath it.
    const shell = [{ ...root, depth: 0 }, ...collectDescendantsFromIndex(processIndex, rootPid)]
      .map((row) => ({ depth: row.depth, executable: commandExecutable(row.command) }))
      .filter((row) => isShellProcess(row.executable))
      .sort((left, right) => left.depth - right.depth)[0]
    return shell
      ? await confirmShellForegroundProcess(rootPid, shell.executable, { ...options, processIndex })
      : false
  } catch {
    return false
  }
}

/** Windows: the host's job-based child census found nothing under the shell. */
export function inspectionShowsShellAlone(inspection: TerminalProcessInspection | null): boolean {
  if (!inspection || inspection.verdict === 'unverifiable') {
    return false
  }
  return (
    inspection.childProcessEvidence === 'no-children' &&
    (inspection.foregroundProcess === null || isShellProcess(inspection.foregroundProcess))
  )
}
