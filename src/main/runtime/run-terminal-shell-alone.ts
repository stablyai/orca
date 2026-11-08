/** Read execution-host process tables: daemon shell-ownership changes only after full-screen exit and misses plain failed/finished commands. Observation failure is unproven. */
import { confirmShellForegroundProcess } from '../providers/agent-foreground-process'
import { getFreshProcessTableSnapshot } from '../../shared/process-table-snapshot-reader'
import { getProcessTableIndex } from '../../shared/process-table-index'
import { isShellProcess } from '../../shared/agent-status/process/shell-process-detection'

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
