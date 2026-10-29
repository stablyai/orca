// A shell prompt can look complete even after command-not-found; require fresh agent completion.
// Status-free panes may finish after startup grace if the shell did not refuse the command.
import type { AgentStatusIpcPayload } from '../shared/agent-status-types'

/** Covers agent spin-up over SSH before an idle pane without agent status is believed. */
export const AGENT_START_GRACE_MS = 2 * 60 * 1000
/** Only output after the prompt: a refusal further up predates this turn. */
const MISSING_COMMAND_TAIL_LINES = 6

// bash, zsh, dash/sh, fish, PowerShell and cmd.exe refusing a command that does not exist.
const MISSING_COMMAND_PATTERNS = [
  /command not found/i,
  /^\S+: \d+: \S+: not found$/i,
  /unknown command/i,
  /is not recognized as (?:the name of a cmdlet|an internal or external command)/i
]

export type AgentTurnStatusRow = Pick<
  AgentStatusIpcPayload,
  'state' | 'stateStartedAt' | 'sessionBoundary' | 'providerSessionOnly'
>

export type IdleAgentTurnEvidence = {
  rows: readonly AgentTurnStatusRow[]
  /** Ignore status from turns before this prompt. */
  sentAt: number
  tail: readonly string[]
  /** Read only when no fresh `done` decides it: the names the agent command may run under. */
  readAgentCommands: () => readonly string[]
}

export type IdleAgentTurnVerdict =
  | { kind: 'completed' }
  | { kind: 'failed'; missingCommandLine: string }
  /** An idle shell that may not have started the agent yet. */
  | { kind: 'wait' }

/** Match shell refusals of the agent command, excluding commands run by its tools. */
export function findMissingCommandLine(
  tail: readonly string[],
  commands: readonly string[]
): string | null {
  const names = commands.map((command) => command.split(/\s+/)[0]).filter(Boolean)
  const recent = tail
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-MISSING_COMMAND_TAIL_LINES)
  return (
    recent.find(
      (line) =>
        MISSING_COMMAND_PATTERNS.some((pattern) => pattern.test(line)) &&
        names.some((name) => line.includes(name))
    ) ?? null
  )
}

/** The agent's own report that the turn sent at `sentAt` ended; a connect-time `done` reports no turn. */
export function isTurnDoneSince(row: AgentTurnStatusRow, sentAt: number): boolean {
  return (
    !row.providerSessionOnly &&
    row.state === 'done' &&
    !row.sessionBoundary &&
    row.stateStartedAt >= sentAt
  )
}

export function judgeIdleAgentTurn(
  evidence: IdleAgentTurnEvidence,
  now: number
): IdleAgentTurnVerdict {
  const { sentAt } = evidence
  // Resume identity is no status report.
  const rows = evidence.rows.filter((row) => !row.providerSessionOnly)
  if (rows.some((row) => isTurnDoneSince(row, sentAt))) {
    return { kind: 'completed' }
  }
  const missing = findMissingCommandLine(evidence.tail, evidence.readAgentCommands())
  if (missing) {
    return { kind: 'failed', missingCommandLine: missing }
  }
  // Only an agent that never reports status is believed done by an idle pane.
  return rows.length === 0 && now - sentAt >= AGENT_START_GRACE_MS
    ? { kind: 'completed' }
    : { kind: 'wait' }
}
