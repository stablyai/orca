/** Read execution-host process tables: daemon shell-ownership changes only after full-screen exit and misses plain failed/finished commands. Observation failure is unproven. */
import {
  commandExecutable,
  confirmShellForegroundProcess
} from '../../../providers/foreground/agent-process'
import { getFreshShellForegroundSnapshot } from '../../../../shared/process-observation/tables/process-table-snapshot-reader'
import {
  collectDescendantsFromIndex,
  getProcessTableIndex
} from '../../../../shared/process-observation/tables/process-table-index'
import { recognizeAgentProcessFromCommandLine } from '../../../../shared/agent-status/process/agent-process-recognition'
import { isShellProcess } from '../../../../shared/agent-status/process/shell-process-detection'
import type { TerminalProcessInspection } from '../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'

/** The pane's agent (any agent when unknown) still alive under the shell, stopped or in the
 *  background, keeps its exit unproven; a stopped editor or another agent suspended before it does
 *  not. */
export function paneAgentProcess(
  agent?: string
): (row: { command: string; stat?: string }) => boolean {
  return (row) => {
    // A live process whose argv the host couldn't read shows as `(comm)`; its name still tells.
    const unreadable = /^\((.*)\)$/.exec(row.command.trim())
    if (unreadable && row.stat?.includes('Z')) {
      return false
    }
    const recognized = recognizeAgentProcessFromCommandLine(unreadable?.[1] ?? row.command)
    return recognized !== null && (!agent || recognized.agent === agent)
  }
}

/** POSIX: the PTY's shell owns the terminal's foreground group and nothing under it is stopped
 *  (or, given `paneAgent`, no process under it runs the pane's agent, in any state). */
export async function confirmRootShellAloneFromProcessTable(
  rootPid: number,
  options?: { paneAgent?: (row: { command: string; stat?: string }) => boolean }
): Promise<boolean> {
  try {
    const processIndex = getProcessTableIndex(await getFreshShellForegroundSnapshot())
    const root = processIndex.byPid.get(rootPid)
    if (!root) {
      return false
    }
    // macOS roots each PTY at /usr/bin/login, with the login shell beneath it.
    const tree = [{ ...root, depth: 0 }, ...collectDescendantsFromIndex(processIndex, rootPid)]
    const paneAgent = options?.paneAgent
    if (paneAgent && tree.some((row) => row.depth > 0 && paneAgent(row))) {
      return false
    }
    const shell = tree
      .map((row) => ({ depth: row.depth, executable: commandExecutable(row.command) }))
      .filter((row) => isShellProcess(row.executable))
      .sort((left, right) => left.depth - right.depth)[0]
    return shell
      ? await confirmShellForegroundProcess(rootPid, shell.executable, {
          processIndex,
          ...(paneAgent ? { stoppedJobBlocks: () => false } : {})
        })
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
