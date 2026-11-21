import {
  isExpectedAgentProcess,
  isAgentForegroundWrapperProcess,
  isNodeInterpreterOfAgent,
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from '../../../../shared/agent-status/process/agent-process-recognition'
import { PROCESS_TABLE_SNAPSHOT_MAX_STALENESS_MS } from '../../../../shared/process-observation/tables/process-table-snapshot'
import { isShellProcess } from '../../../../shared/agent-status/process/shell-process-detection'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'
import { judgeTerminalForeground } from '../lifecycle/terminal-foreground-group'
import { readTerminalProcessRows } from '../../../pty/process-retirement/terminal-process-rows'
import { readProcessStartTimeMs } from '../../agent-session/ownership/agent-session-process-identity-probe'
import { isTerminalForegroundObservation } from '../../../../shared/terminal/pty/lifecycle/terminal-foreground-observation'
import { readLegacyPtyRootProcessId } from './legacy-pty-root-process'
import { findStoppedAgents } from '../../../../shared/agent-status/process/stopped-agent-process'

/** agent permits writing; shell drops readiness; unknown proves neither. */
export type LaunchedAgentForeground = 'agent' | 'shell' | 'unknown'
export type MailboxForeground = LaunchedAgentForeground | 'non-shell'
/** A local POSIX agent's process, so a returning agent can be told apart from a new one of its kind. */
export type MailboxAgentProcess = { pid: number; startedAtMs: number }
export type MailboxForegroundInspection = {
  foreground: MailboxForeground
  agent?: TuiAgent
  process?: MailboxAgentProcess
}

/** Set when the read's own fresh, fenced observation named exactly the agent asked about. */
export type ExactAgentName = { named: boolean }

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
type ForegroundController = Pick<
  RuntimePtyController,
  | 'supportsForegroundObservation'
  | 'getForegroundProcess'
  | 'confirmForegroundProcess'
  | 'confirmShellForeground'
  | 'inspectProcess'
  | 'listProcesses'
> | null

/** Another program in front holds mail only in place of a stopped agent; otherwise it may relay to the agent elsewhere. */
function otherProgram(
  stoppedAgents: readonly string[] | undefined,
  agent: TuiAgent | undefined
): MailboxForeground {
  return stoppedAgents?.length && (!agent || stoppedAgents.includes(agent))
    ? 'non-shell'
    : 'unknown'
}

export async function inspectLaunchedAgentForeground(
  controller: ForegroundController,
  host: { remote: boolean; windows: boolean },
  ptyId: string,
  agent?: TuiAgent,
  expectedIncarnationId?: string,
  exact?: ExactAgentName,
  mailboxEvidence = false,
  onAgent?: (agent: TuiAgent, process?: MailboxAgentProcess) => void
): Promise<MailboxForeground> {
  if (!controller) {
    return 'unknown'
  }
  const recognizeForeground = (processName: string | null): TuiAgent | undefined => {
    const recognized = recognizeAgentProcessFromCommandLine(processName)?.agent
    const candidate = agent ?? recognized
    if (
      isTuiAgent(candidate) &&
      processName &&
      (recognized === candidate || (agent && isLaunchedAgent(processName, agent)))
    ) {
      onAgent?.(candidate)
      return candidate
    }
    return undefined
  }
  try {
    if (host.windows) {
      // Windows SSH relays lack even the shell-alone check.
      return (await controller.confirmShellForeground?.(ptyId)) ? 'shell' : 'unknown'
    }
    if (controller.supportsForegroundObservation?.(ptyId)) {
      const result = await controller.inspectProcess?.(ptyId, {
        foregroundOnly: true,
        ...(expectedIncarnationId ? { expectedIncarnationId } : {})
      })
      if (result && result.foregroundObservation !== undefined) {
        const observation = result.foregroundObservation
        if (
          !isTerminalForegroundObservation(observation) ||
          observation.ptyId !== ptyId ||
          (expectedIncarnationId && observation.ptyIncarnationId !== expectedIncarnationId) ||
          observation.verdict !== 'observed'
        ) {
          return 'unknown'
        }
        if (exact && agent) {
          exact.named = recognizeAgentProcess(observation.processName)?.agent === agent
        }
        if (mailboxEvidence) {
          if (observation.foregroundKind === 'shell') {
            return 'shell'
          }
          // The agent's own process and its start time tell a returning agent from a new one; a wrapper leading the job would not.
          const identify = async (found: TuiAgent): Promise<'agent'> => {
            // Why the job leader as fallback: older daemons and name-confirmed agents carry no agentPid.
            const pid = observation.agentPid ?? observation.foregroundPgid
            const startedAtMs = !host.remote && pid ? await readProcessStartTimeMs(pid) : null
            if (pid && startedAtMs !== null) {
              onAgent?.(found, { pid, startedAtMs })
            }
            return 'agent'
          }
          const named = recognizeForeground(observation.processName)
          if (named) {
            return await identify(named)
          }
          // Why no confirm when the expected agent is stopped behind it: the host-wide read could only name a program other than it.
          if (
            (!agent || observation.stoppedAgents?.includes(agent)) &&
            observation.processName &&
            !isAgentForegroundWrapperProcess(observation.processName) &&
            !/(?:^|[/\\])v?\d+(?:\.\d+)+(?:[-+][\w.-]+)?$/i.test(observation.processName)
          ) {
            return otherProgram(observation.stoppedAgents, agent)
          }
          // Native version names and interpreter wrappers need the host's fresh executable read.
          const confirmed = recognizeForeground(
            (await controller.confirmForegroundProcess?.(ptyId)) ?? null
          )
          return confirmed
            ? await identify(confirmed)
            : otherProgram(observation.stoppedAgents, agent)
        }
        // Local launch policy admits non-shell user wrappers independently of mail's identity proof.
        if (!host.remote) {
          return observation.foregroundKind === 'shell' ? 'shell' : agent ? 'agent' : 'unknown'
        }
        return agent
          ? judgeFreshForeground(observation.processName, agent)
          : observation.processName && isLaunchShell(observation.processName)
            ? 'shell'
            : 'unknown'
      }
    }
    if (!host.remote) {
      const root = await readLegacyPtyRootProcessId(
        controller,
        ptyId,
        expectedIncarnationId,
        // Why mail only: its retries repeat the read; a launch check asks once.
        mailboxEvidence
      )
      if (root === 'replaced') {
        return 'unknown'
      }
      const rootPid = root
      const rows = rootPid ? await readTerminalProcessRows(rootPid) : null
      const verdict = rows && rootPid ? judgeTerminalForeground(rows, rootPid, agent) : 'unknown'
      if (mailboxEvidence && verdict !== 'unknown') {
        const group = rows?.find((row) => row.pid === rootPid)?.tpgid
        const agentRow = rows?.find((row) => {
          const candidate = recognizeAgentProcessFromCommandLine(row.command)?.agent
          return row.pgid === group && isTuiAgent(candidate) && (!agent || candidate === agent)
        })
        const found = agentRow && recognizeAgentProcessFromCommandLine(agentRow.command)?.agent
        if (agentRow && isTuiAgent(found)) {
          const startedAtMs = await readProcessStartTimeMs(agentRow.pid)
          onAgent?.(
            agent ?? found,
            startedAtMs === null ? undefined : { pid: agentRow.pid, startedAtMs }
          )
          return 'agent'
        }
        if (verdict === 'agent') {
          return otherProgram(rows ? findStoppedAgents(rows, group) : undefined, agent)
        }
        return verdict
      }
      return !agent && verdict === 'agent' ? 'unknown' : verdict
    }
    const askedAt = Date.now()
    const evidence = (await controller.inspectProcess?.(ptyId))?.foregroundProcessEvidence
    if (
      evidence?.verdict === 'live' &&
      evidence.fence.platform === 'posix' &&
      evidence.processName &&
      (mailboxEvidence
        ? recognizeForeground(evidence.processName)
        : agent && isLaunchedAgent(evidence.processName, agent))
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
        const processName = await controller.confirmForegroundProcess(ptyId)
        return mailboxEvidence
          ? recognizeForeground(processName)
            ? 'agent'
            : processName && isLaunchShell(processName)
              ? 'shell'
              : 'unknown'
          : agent
            ? judgeFreshForeground(processName, agent)
            : 'unknown'
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
      (!agent || !isExpectedAgentProcess(foreground, TUI_AGENT_CONFIG[agent].expectedProcess))
    ) {
      return 'shell'
    }
    if (!agent && !(mailboxEvidence && completable && recognizeForeground(foreground))) {
      return 'unknown'
    }
    // Legacy: relays that send no evidence (older versions) keep the possibly cached name.
    if (!evidence) {
      return mailboxEvidence ? 'unknown' : 'agent'
    }
    if (!completable) {
      return 'unknown'
    }
    // Relays before same-agent dedupe call npm Codex's two rows ambiguous and name its `node` wrapper.
    return (mailboxEvidence
      ? recognizeForeground(foreground)
      : agent && isLaunchedAgent(foreground, agent)) ||
      (evidence.reason === 'ambiguous_foreground_group' &&
        agent &&
        isNodeInterpreterOfAgent(foreground, agent))
      ? 'agent'
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

export type ForegroundReadArgs = [
  controller: ForegroundController,
  host: { remote: boolean; windows: boolean },
  ptyId: string,
  agent?: TuiAgent,
  expectedIncarnationId?: string
]

export async function readLaunchedAgentForeground(
  ...args: [...ForegroundReadArgs, exact?: ExactAgentName]
): Promise<LaunchedAgentForeground> {
  const result = await inspectLaunchedAgentForeground(...args)
  return result === 'non-shell' ? 'unknown' : result
}
