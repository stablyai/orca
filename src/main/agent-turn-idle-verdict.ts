/**
 * Whether an agent's turn, sent at a known moment, is really over once its pane reads idle. A ready
 * shell prompt satisfies `tui-idle` too, so a prompt typed at a shell whose agent is not installed
 * ("command not found") would read as finished. The agent's own `done`, reached since the turn was
 * sent, completes it; a reused pane's previous `done` is not this turn's. Not every agent reports
 * status (no hooks on the host, no recognised title), so for a pane that never reported any an idle
 * pane still means done, but only after the agent had time to start and only when no shell refused
 * its command. Automations judge their runs by it; a connector judges each message's turn by it.
 */
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
  /** The pane's agent status rows, from hooks, OSC and titles alike. */
  rows: readonly AgentTurnStatusRow[]
  /** When the turn's prompt went in: status from before it is a previous turn's. */
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

/** A shell refusing one of the agent's own commands; an agent's tool output never matches. */
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

export function judgeIdleAgentTurn(
  evidence: IdleAgentTurnEvidence,
  now: number
): IdleAgentTurnVerdict {
  const { sentAt } = evidence
  // Resume identity is no status report.
  const rows = evidence.rows.filter((row) => !row.providerSessionOnly)
  if (
    rows.some(
      (row) =>
        // A connect-time `done` reports no turn.
        row.state === 'done' && !row.sessionBoundary && row.stateStartedAt >= sentAt
    )
  ) {
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
