import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status/contracts/agent-status-types'
import { mainAgentDoneAt } from '../../shared/agent-status/lifecycle/main-agent-status'
import {
  describeTerminalExitCause,
  type TerminalExitCause
} from '../../shared/terminal/pty/lifecycle/terminal-exit-cause'
import {
  automationRunFailure,
  type AutomationRunFailure
} from '../../shared/automations/history/automation-run-failure-copy'
import {
  isTurnDoneSince,
  judgeIdleAgentTurn,
  type AgentTurnStatusRow
} from '../runtime/agent-state-rules/agent-turn-idle-verdict'

export { AGENT_START_GRACE_MS } from '../runtime/agent-state-rules/agent-turn-idle-verdict'

type AutomationRunStatusRow = AgentTurnStatusRow &
  Partial<
    Pick<
      ParsedAgentStatusPayload,
      'mainAgent' | 'lastAssistantMessage' | 'lastAssistantMessageIsToolOutput'
    >
  >

export type AutomationRunAgentEvidence = {
  getAgentStatusRowsForPane(paneKey: string): readonly AutomationRunStatusRow[]
  /** The lead's full final reply for that finished turn; rows carry only a capped preview. */
  getAcceptedReply(paneKey: string, leadTurnKey: number): string | undefined
  /** Calls back synchronously on every status row change, including the clear when an agent exits. */
  subscribeStatusChanges(listener: (paneKey: string) => void): () => void
  /** Executable aliases used to distinguish a launch refusal from ordinary output. */
  agentCommandsForRun(run: AutomationRun): readonly string[]
}

export type IdleRunVerdict =
  | { kind: 'completed' }
  | ({ kind: 'failed' } & AutomationRunFailure)
  /** An idle shell that may not have started the agent yet. */
  | { kind: 'wait' }

export function judgeIdleRun(
  evidence: AutomationRunAgentEvidence,
  run: AutomationRun,
  tail: readonly string[],
  runStartedAt: number,
  now: number
): IdleRunVerdict {
  const verdict = judgeIdleAgentTurn(
    {
      rows: run.terminalPaneKey ? evidence.getAgentStatusRowsForPane(run.terminalPaneKey) : [],
      // Ignore completion evidence from before this run’s prompt.
      sentAt: run.dispatchedAt ?? runStartedAt,
      tail,
      readAgentCommands: () => evidence.agentCommandsForRun(run)
    },
    now
  )
  if (verdict.kind === 'failed') {
    return {
      kind: 'failed',
      error: `Automation agent did not start; this host could not run its command (${verdict.missingCommandLine}).`
    }
  }
  if (verdict.kind === 'completed' && verdict.interrupted) {
    return { kind: 'failed', ...automationRunFailure('agentInterrupted') }
  }
  return verdict.kind === 'completed' ? { kind: 'completed' } : verdict
}

/** The run's verdict once the agent reported its turn done at least `heldForMs` ago and no row of its pane says otherwise; null until then. Decided from one read of the rows, so a row cleared afterwards cannot change it. */
export function judgeHeldRunTurn(
  evidence: AutomationRunAgentEvidence,
  run: AutomationRun,
  runStartedAt: number,
  now: number,
  heldForMs: number
): Exclude<IdleRunVerdict, { kind: 'wait' }> | null {
  const sentAt = run.dispatchedAt ?? runStartedAt
  const rows = (
    run.terminalPaneKey ? evidence.getAgentStatusRowsForPane(run.terminalPaneKey) : []
  ).filter((row) => !row.providerSessionOnly)
  const done = rows.filter((row) => isTurnDoneSince(row, sentAt))
  if (
    !rows.every((row) => row.state === 'done') ||
    !done.some((row) => now - row.stateStartedAt >= heldForMs)
  ) {
    return null
  }
  return done.some((row) => row.interrupted === true)
    ? { kind: 'failed', ...automationRunFailure('agentInterrupted') }
    : { kind: 'completed' }
}

export type RunAgentReply = { text: string; truncated: boolean }

/** This run's latest finished turn: whether it was cut off, and what the agent answered. */
export type RunAgentTurn = { interrupted: boolean; reply: RunAgentReply | null }

/** A run watched with its agent's status evidence; `turn` is its latest captured finished turn. */
export type JudgedRun = {
  evidence: AutomationRunAgentEvidence
  run: AutomationRun
  turn: () => RunAgentTurn | null
}

/** The run's latest finished turn. Its reply is the full accepted one, else the status preview,
 *  which the status cap may have cut by an amount its length cannot show. */
export function runAgentTurn(
  evidence: AutomationRunAgentEvidence,
  run: AutomationRun,
  runStartedAt: number
): RunAgentTurn | null {
  const paneKey = run.terminalPaneKey
  const sentAt = run.dispatchedAt ?? runStartedAt
  const row = (paneKey ? evidence.getAgentStatusRowsForPane(paneKey) : [])
    .filter((entry) => isTurnDoneSince(entry, sentAt))
    .toSorted((left, right) => right.stateStartedAt - left.stateStartedAt)[0]
  if (!paneKey || !row) {
    return null
  }
  const interrupted = row.interrupted === true
  const leadTurnKey = mainAgentDoneAt(row)
  const accepted =
    leadTurnKey === undefined ? undefined : evidence.getAcceptedReply(paneKey, leadTurnKey)
  if (accepted?.trim()) {
    return { interrupted, reply: { text: accepted, truncated: false } }
  }
  // Tool stdout is not the agent's answer.
  const preview = row.lastAssistantMessageIsToolOutput ? undefined : row.lastAssistantMessage
  return { interrupted, reply: preview?.trim() ? { text: preview, truncated: true } : null }
}

/** Holds this run's latest finished turn as its status changes, so the clear when the agent exits
 *  cannot erase it before the run settles. */
export function captureRunAgentTurn(
  evidence: AutomationRunAgentEvidence,
  run: AutomationRun,
  runStartedAt: number
): JudgedRun & { stop: () => void } {
  let latest = runAgentTurn(evidence, run, runStartedAt)
  const stop = evidence.subscribeStatusChanges((paneKey) => {
    if (paneKey === run.terminalPaneKey) {
      latest = runAgentTurn(evidence, run, runStartedAt) ?? latest
    }
  })
  return { evidence, run, turn: () => runAgentTurn(evidence, run, runStartedAt) ?? latest, stop }
}

/** A proven agent exit's verdict: exit 0 completes the run unless its latest turn was cut off. */
export function judgeRunExit(
  exit: TerminalExitCause,
  judged: JudgedRun | null
): Exclude<IdleRunVerdict, { kind: 'wait' }> {
  if (judged?.turn()?.interrupted) {
    return { kind: 'failed', ...automationRunFailure('agentInterrupted') }
  }
  return exit.kind === 'exited' && exit.exitCode === 0
    ? { kind: 'completed' }
    : { kind: 'failed', error: `${describeTerminalExitCause(exit)}.` }
}
