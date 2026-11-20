import { agentOf } from '../../../../shared/agent-hook-listener/presence/hook-process-root-evidence'
import { tokenizeCommandLine } from '../../../../shared/agent-status/process/agent-command-line-entrypoint'
import { classifyClaudeArgv } from '../../../../shared/agent-status/title/claude-cli-argv-classification'
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

/** The interactive agent a process row runs, never a one-shot that cannot take mail.
 * Why agentOf: native installs exec a versioned binary (`…/claude/versions/2.1.0`) the bare recognizer misses.
 * Why Claude's grammar: print mode hides in short-flag clusters (`-pc`) the shared one-shot filter misses. */
function mailAgentOf(command: string): string | undefined {
  const agent = agentOf(command, false)
  return agent === 'claude' &&
    classifyClaudeArgv(tokenizeCommandLine(command).slice(1)) === 'headless'
    ? undefined
    : agent
}

/** Mail's read of an older daemon's terminal rows: the agent's own process in front, or a program standing in for a stopped one. */
export async function judgeLegacyMailboxRows(
  rows: readonly ProcessTableRow[],
  rootPid: number,
  verdict: LaunchedAgentForeground,
  agent: TuiAgent | undefined,
  onAgent?: (agent: TuiAgent, process?: MailboxAgentProcess) => void
): Promise<MailboxForeground> {
  const group = rows.find((row) => row.pid === rootPid)?.tpgid
  const agentRow = rows.find((row) => {
    const candidate = mailAgentOf(row.command)
    return row.pgid === group && isTuiAgent(candidate) && (!agent || candidate === agent)
  })
  const found = agentRow && mailAgentOf(agentRow.command)
  if (agentRow && isTuiAgent(found)) {
    const startedAtMs = await readProcessStartTimeMs(agentRow.pid)
    onAgent?.(agent ?? found, startedAtMs === null ? undefined : { pid: agentRow.pid, startedAtMs })
    return 'agent'
  }
  return verdict === 'agent' ? otherProgram(findStoppedAgents(rows, group), agent) : verdict
}
