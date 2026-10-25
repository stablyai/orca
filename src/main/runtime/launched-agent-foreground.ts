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

/**
 * What holds a launched agent's terminal: the agent (anything but the pane's shell), the shell
 * (the launch line has not run yet, or the agent exited), or `unknown` when the host cannot tell.
 * Only `agent` lets a launch write its prompt; only `shell` drops a ready signal.
 */
export type LaunchedAgentForeground = 'agent' | 'shell' | 'unknown'

/** A login shell is reported as `-zsh`. */
function isLaunchShell(processName: string): boolean {
  return isShellProcess(processName.replace(/^-/, ''))
}

function isLaunchedAgent(processName: string, agent: TuiAgent): boolean {
  return (
    recognizeAgentProcess(processName)?.agent === agent ||
    isExpectedAgentProcess(processName, TUI_AGENT_CONFIG[agent].expectedProcess)
  )
}

/**
 * On a local macOS or Linux host, one `ps` limited to the pane's own terminal
 * (`terminal-foreground-group`): its foreground process group decides, read fresh in a few
 * milliseconds. Never the whole-machine capture behind a fresh scan or `inspectProcess`, which
 * took seconds a read on a loaded host and gated every paste behind it, and never the cached name a
 * tab icon uses, which can still name a process that already exited.
 *
 * On an SSH host, the relay's process-group observation when it names the launched agent in the
 * foreground group (a wrapper that did not `exec` it leads the group), then the relay's own name,
 * which it reads from the terminal when asked. The observation never proves a shell.
 *
 * Windows has no foreground process group, and its scan names the pane's shell for an agent it
 * cannot recognize, while Git Bash and WSL keep other processes in the shell's job, so nothing
 * there proves the agent. A Windows host can still prove its shell alone (`confirmShellForeground`).
 */
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
      // An SSH pane has no such check, so on a Windows relay nothing proves a shell.
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
