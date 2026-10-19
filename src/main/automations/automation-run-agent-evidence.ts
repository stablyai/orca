/**
 * What an idle pane says about a run. A ready shell prompt satisfies `tui-idle` too, so a prompt
 * typed at a shell whose agent is not installed ("command not found") would read as finished.
 * The agent's own `done`, reached since the run was dispatched, completes it as on the desktop; a
 * reused pane's previous `done` is not this run's. Not every agent reports status (no hooks on the
 * host, no recognised title), so for a pane that never reported any an idle pane still means done,
 * but only after the agent had time to start and only when no shell refused its command.
 */
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { AutomationRun } from '../../shared/automations-types'

/** Covers agent spin-up over SSH before an idle pane without agent status is believed. */
export const AGENT_START_GRACE_MS = 2 * 60 * 1000
/** Only output after the prompt: a refusal further up predates this run. */
const MISSING_COMMAND_TAIL_LINES = 6

// bash, zsh, dash/sh, fish, PowerShell and cmd.exe refusing a command that does not exist.
const MISSING_COMMAND_PATTERNS = [
  /command not found/i,
  /^\S+: \d+: \S+: not found$/i,
  /unknown command/i,
  /is not recognized as (?:the name of a cmdlet|an internal or external command)/i
]

export type AutomationRunAgentEvidence = {
  /** Agent status rows for a pane, from hooks, OSC and titles alike. */
  getAgentStatusRowsForPane(
    paneKey: string
  ): readonly Pick<
    AgentStatusIpcPayload,
    'state' | 'stateStartedAt' | 'sessionBoundary' | 'providerSessionOnly'
  >[]
  /** The names the run's agent command may run under, to tell its refusal from its output. */
  agentCommandsForRun(run: AutomationRun): readonly string[]
}

export type IdleRunVerdict =
  | { kind: 'completed' }
  | { kind: 'failed'; error: string }
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

export function judgeIdleRun(
  evidence: AutomationRunAgentEvidence,
  run: AutomationRun,
  tail: readonly string[],
  runStartedAt: number,
  now: number
): IdleRunVerdict {
  // A reused pane's earlier `done` ended before this run's prompt went in.
  const since = run.dispatchedAt ?? runStartedAt
  // Resume identity is no status report.
  const rows = run.terminalPaneKey
    ? evidence
        .getAgentStatusRowsForPane(run.terminalPaneKey)
        .filter((row) => !row.providerSessionOnly)
    : []
  if (
    rows.some(
      (row) =>
        // A connect-time `done` reports no turn.
        row.state === 'done' && !row.sessionBoundary && row.stateStartedAt >= since
    )
  ) {
    return { kind: 'completed' }
  }
  const missing = findMissingCommandLine(tail, evidence.agentCommandsForRun(run))
  if (missing) {
    return {
      kind: 'failed',
      error: `Automation agent did not start; this host could not run its command (${missing}).`
    }
  }
  // Only an agent that never reports status is believed done by an idle pane.
  return rows.length === 0 && now - since >= AGENT_START_GRACE_MS
    ? { kind: 'completed' }
    : { kind: 'wait' }
}
