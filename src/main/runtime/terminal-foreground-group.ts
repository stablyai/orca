import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { unreadableArgvName, type ProcessTableRow } from '../../shared/process-table-snapshot'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { TuiAgent } from '../../shared/tui-agent'
export { readTerminalProcessRows } from '../pty/terminal-process-rows'

function isShellCommand(command: string): boolean {
  const executable = command.trim().split(/\s+/, 1)[0]?.replace(/^-/, '') ?? ''
  return isShellProcess(executable.split('/').pop() ?? executable)
}

/** Judge the foreground group: any agent/non-shell counts as agent, shell-only wrappers as shell. Never assume root is shell; macOS uses login. */
export function judgeTerminalForeground(
  rows: readonly ProcessTableRow[],
  rootPid: number,
  agent: TuiAgent
): 'agent' | 'shell' | 'unknown' {
  const root = rows.find((row) => row.pid === rootPid)
  const foregroundGroup = root?.tpgid
  if (foregroundGroup === undefined || foregroundGroup <= 0) {
    return 'unknown'
  }
  const front = rows.filter((row) => row.pgid === foregroundGroup)
  // An unrecovered root shell (`su`) prints `(bash)`; typing into it could run the text. Our own exiting `(git)` is no risk.
  const unreadableShell = (row: ProcessTableRow): boolean => {
    const name = unreadableArgvName(row.command)
    return name !== null && isShellProcess(name.replace(/^-/, ''))
  }
  // A blank argv names nothing, so it proves neither shell nor agent.
  if (front.length === 0 || front.some((row) => !row.command.trim() || unreadableShell(row))) {
    return 'unknown'
  }
  return front.some(
    (row) =>
      recognizeAgentProcessFromCommandLine(row.command)?.agent === agent ||
      !isShellCommand(row.command)
  )
    ? 'agent'
    : 'shell'
}
