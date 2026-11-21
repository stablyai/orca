import { agentOf } from '../../../../shared/agent-hook-listener/presence/hook-process-root-evidence'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { findStoppedAgents } from '../../../../shared/agent-status/process/stopped-agent-process'
import type { ProcessTableRow } from '../../../../shared/process-observation/tables/process-table-snapshot'
import { readProcessStartTimeMs } from '../../agent-session/ownership/agent-session-process-identity-probe'
import type {
  LaunchedAgentForeground,
  MailboxAgentProcess,
  MailboxForeground
} from './launched-agent-foreground'

/** Another program in front holds mail only in place of a stopped agent; otherwise it may relay to the agent elsewhere. */
export function otherProgram(
  stoppedAgents: readonly string[] | undefined,
  agent: TuiAgent | undefined
): MailboxForeground {
  return stoppedAgents?.length && (!agent || stoppedAgents.includes(agent))
    ? 'non-shell'
    : 'unknown'
}

/** Mail's read of an older daemon's terminal rows: the agent's own process in front, or a program standing in for a stopped one. */
export async function judgeLegacyMailboxRows(
  rows: readonly ProcessTableRow[],
  rootPid: number,
  verdict: LaunchedAgentForeground,
  agent: TuiAgent | undefined,
  onAgent?: (agent: TuiAgent, process?: MailboxAgentProcess) => void
): Promise<MailboxForeground> {
  // Why: mail only narrows the daemon-era verdict, so a shell (even a script named for an agent) stays a shell.
  if (verdict !== 'agent') {
    return verdict
  }
  const group = rows.find((row) => row.pid === rootPid)?.tpgid
  // Why agentOf: native installs exec a versioned binary (`…/claude/versions/2.1.0`) the bare recognizer misses.
  // Why one-shots count: ps flattens argv, so a prompt ending `--print` would read as one and hold mail forever.
  const agentRow = rows.find((row) => {
    const candidate = agentOf(row.command)
    return row.pgid === group && isTuiAgent(candidate) && (!agent || candidate === agent)
  })
  const found = agentRow && agentOf(agentRow.command)
  if (agentRow && isTuiAgent(found)) {
    const startedAtMs = await readProcessStartTimeMs(agentRow.pid)
    onAgent?.(agent ?? found, startedAtMs === null ? undefined : { pid: agentRow.pid, startedAtMs })
    return 'agent'
  }
  // Why the old verdict otherwise: ps text can hide the agent (a space in its path), and holding on that never releases.
  return otherProgram(findStoppedAgents(rows, group), agent) === 'non-shell' ? 'non-shell' : verdict
}
