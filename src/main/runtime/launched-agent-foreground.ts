import {
  isExpectedAgentProcess,
  isNodeInterpreterOfAgent,
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

export type LaunchedAgentHost = {
  remote: boolean
  windows: boolean
  /** Only a local non-WSL Windows pane can prove its shell alone in its job; wsl.exe and SSH reads stay unknown. */
  shellAloneProvable: boolean
}

export function describeLaunchedAgentHost(
  pty: { connectionId: string | null; isWsl: boolean | null } | undefined,
  remotePathFlavor: () => 'posix' | 'win32'
): LaunchedAgentHost {
  const remote = !!pty?.connectionId
  // A local WSL pane still runs on a Windows host, whose process reads cannot see into it.
  const windows = remote ? remotePathFlavor() === 'win32' : process.platform === 'win32'
  return { remote, windows, shellAloneProvable: windows && !remote && pty?.isWsl === false }
}

/** Unverifiable reasons that still saw an agent row in the pane's foreground group. Anything else (an unreadable
 * table, a missing anchor, another terminal such as `sudo -i`'s pty, withheld argv, a reason this build does not know)
 * proves nothing, so a cached name cannot fill the gap. */
const NAME_COMPLETES_EVIDENCE: ReadonlySet<string> = new Set([
  'ambiguous_foreground_group',
  'multiplexer_boundary',
  'candidate_start_time_missing'
])

// A relay's cached snapshot is up to one TTL old plus its capture time, which a busy host keeps under another TTL.
const EVIDENCE_MAX_AGE_MS = 2 * PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS

function judgeFreshForeground(
  processName: string | null,
  agent: TuiAgent
): LaunchedAgentForeground {
  if (processName && isLaunchedAgent(processName, agent)) {
    return 'agent'
  }
  return processName && isLaunchShell(processName) ? 'shell' : 'unknown'
}

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
    | 'getForegroundProcess'
    | 'confirmForegroundProcess'
    | 'confirmShellForeground'
    | 'inspectProcess'
    | 'listProcesses'
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
      evidence.processName &&
      isLaunchedAgent(evidence.processName, agent)
    ) {
      // Begun no more than one TTL before the read was asked (so any age within one TTL), however long ps took.
      if (
        Date.now() - evidence.capturedAgeMs >=
        askedAt - PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS
      ) {
        return 'agent'
      }
      // Up to two TTLs the agent may have exited since: a foreground read now decides.
      if (evidence.capturedAgeMs <= EVIDENCE_MAX_AGE_MS && controller.confirmForegroundProcess) {
        return judgeFreshForeground(await controller.confirmForegroundProcess(ptyId), agent)
      }
    }
    // Only evidence that saw an agent row it could not fence alone lets a name complete it.
    const completable =
      evidence?.verdict === 'unverifiable' &&
      evidence.capturedAgeMs <= EVIDENCE_MAX_AGE_MS &&
      NAME_COMPLETES_EVIDENCE.has(evidence.reason)
    // The tracker's name can be its 1s display cache; for completion read it now where the host can.
    const foreground =
      completable && controller.confirmForegroundProcess
        ? await controller.confirmForegroundProcess(ptyId)
        : await controller.getForegroundProcess(ptyId)
    if (!foreground) {
      return 'unknown'
    }
    if (
      isLaunchShell(foreground) &&
      !isExpectedAgentProcess(foreground, TUI_AGENT_CONFIG[agent].expectedProcess)
    ) {
      return 'shell'
    }
    // Legacy: relays that send no evidence (older versions) keep the possibly cached name.
    if (!evidence) {
      return 'agent'
    }
    if (!completable) {
      return 'unknown'
    }
    // Relays before same-agent dedupe call npm Codex's two rows ambiguous and name its `node` wrapper.
    return isLaunchedAgent(foreground, agent) ||
      (evidence.reason === 'ambiguous_foreground_group' &&
        isNodeInterpreterOfAgent(foreground, agent))
      ? 'agent'
      : 'unknown'
  } catch {
    return 'unknown'
  }
}
