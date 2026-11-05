import type { AutomationRun } from '../../shared/automations-types'
import {
  automationRunFailure,
  type AutomationRunFailure
} from '../../shared/automation-run-failure-copy'
import {
  isTurnDoneSince,
  judgeIdleAgentTurn,
  type AgentTurnStatusRow
} from '../runtime/agent-state-rules/agent-turn-idle-verdict'

export { AGENT_START_GRACE_MS } from '../runtime/agent-state-rules/agent-turn-idle-verdict'

export type AutomationRunAgentEvidence = {
  getAgentStatusRowsForPane(paneKey: string): readonly AgentTurnStatusRow[]
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
