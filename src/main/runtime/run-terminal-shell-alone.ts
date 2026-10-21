/**
 * Proof that a run terminal's shell is alone at its prompt, read from the execution host's own
 * process table. The daemon's shell-ownership flag cannot carry it: that flag turns 'shell' only
 * after a full-screen command exits, so a plain "command not found" or an agent that already
 * exited never sets it. Every failure to observe reads as unproven.
 */
import { confirmShellForegroundProcess } from '../providers/agent-foreground-process'
import { getFreshProcessTableSnapshot } from '../../shared/process-table-snapshot-reader'
import { getProcessTableIndex } from '../../shared/process-table-index'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'

/** POSIX: the PTY's root shell owns the terminal's foreground group and nothing under it is stopped. */
export async function confirmRootShellAloneFromProcessTable(rootPid: number): Promise<boolean> {
  try {
    const root = getProcessTableIndex(await getFreshProcessTableSnapshot()).byPid.get(rootPid)
    const executable = root?.command.trim().split(/\s+/, 1)[0] ?? ''
    if (!isShellProcess(executable)) {
      return false
    }
    return await confirmShellForegroundProcess(rootPid, executable)
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
