import {
  isExpectedAgentProcess,
  recognizeAgentProcess
} from '../../shared/agent-process-recognition'
import { PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS } from '../../shared/process-table-snapshot'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import { judgeTerminalForeground, readTerminalProcessRows } from './terminal-foreground-group'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

/** agent permits writing; shell drops readiness; unknown proves neither. */
export type LaunchedAgentForeground = 'agent' | 'shell' | 'unknown'

function isLaunchShell(processName: string): boolean {
  return isShellProcess(processName.replace(/^-/, ''))
}

function isLaunchedAgent(processName: string, agent: TuiAgent): boolean {
  return (
    recognizeAgentProcess(processName)?.agent === agent ||
    isExpectedAgentProcess(processName, TUI_AGENT_CONFIG[agent].expectedProcess)
  )
}

/** Local POSIX uses a fresh terminal-scoped process group, avoiding slow global scans and stale icon names.
 * SSH accepts agent-positive group evidence then the relay's fresh name; group evidence never proves shell.
 * Windows cannot prove agent from shell/node.exe names or shared jobs, only shell-alone via confirmShellForeground. */
export async function readLaunchedAgentForeground(
  controller: Pick<
    RuntimePtyController,
    'getForegroundProcess' | 'confirmShellForeground' | 'inspectProcess' | 'listProcesses'
  > | null,
  host: { remote: boolean; windows: boolean },
  ptyId: string,
  agent: TuiAgent
): Promise<LaunchedAgentForeground> {
  if (!controller) {
    return 'unknown'
  }
  try {
    if (host.windows) {
      // Windows SSH relays lack even the shell-alone check.
      return (await controller.confirmShellForeground?.(ptyId)) ? 'shell' : 'unknown'
    }
    if (!host.remote) {
      const rootPid = (await controller.listProcesses?.(LOCAL_EXECUTION_HOST_ID))?.find(
        (pane) => pane.id === ptyId
      )?.rootProcessId
      const rows = rootPid ? await readTerminalProcessRows(rootPid) : null
      return rows && rootPid ? judgeTerminalForeground(rows, rootPid, agent) : 'unknown'
    }
    const askedAt = Date.now()
    const evidence = (await controller.inspectProcess?.(ptyId))?.foregroundProcessEvidence
    if (
      evidence?.verdict === 'live' &&
      evidence.fence.platform === 'posix' &&
      Date.now() - evidence.capturedAgeMs >= askedAt - PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS &&
      evidence.processName &&
      isLaunchedAgent(evidence.processName, agent)
    ) {
      return 'agent'
    }
    const foreground = await controller.getForegroundProcess(ptyId)
    if (!foreground) {
      return 'unknown'
    }
    return isLaunchShell(foreground) &&
      !isExpectedAgentProcess(foreground, TUI_AGENT_CONFIG[agent].expectedProcess)
      ? 'shell'
      : 'agent'
  } catch {
    return 'unknown'
  }
}
