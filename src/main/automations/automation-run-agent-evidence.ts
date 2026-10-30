import type { TerminalOutputSince } from '../../shared/runtime-terminal-contracts'
import {
  automationRunFailure,
  type AutomationRunFailure
} from '../../shared/automation-run-failure-copy'
import type { AutomationRun } from '../../shared/automations-types'
import {
  isTurnDoneSince,
  judgeIdleAgentTurn,
  type AgentTurnStatusRow
} from '../agent-turn-idle-verdict'

export { AGENT_START_GRACE_MS } from '../agent-turn-idle-verdict'

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
  now: number,
  launchTail?: TerminalOutputSince<readonly string[]> | null
): IdleRunVerdict {
  const verdict = judgeIdleAgentTurn(
    {
      rows: run.terminalPaneKey ? evidence.getAgentStatusRowsForPane(run.terminalPaneKey) : [],
      // Ignore completion evidence from before this run’s prompt.
      sentAt: run.dispatchedAt ?? runStartedAt,
      tail,
      launchTail,
      readAgentCommands: () => evidence.agentCommandsForRun(run)
    },
    now
  )
  if (verdict.kind !== 'failed') {
    return verdict
  }
  return {
    kind: 'failed',
    ...(verdict.reason === 'codex-bootstrap'
      ? automationRunFailure('codexBootstrapFailed')
      : {
          error: `Automation agent did not start; this host could not run its command (${verdict.missingCommandLine}).`
        })
  }
}

/** The agent reported this run's turn done at least `heldForMs` ago, and no row of its pane says otherwise. */
export function hasHeldRunTurnDone(
  evidence: AutomationRunAgentEvidence,
  run: AutomationRun,
  runStartedAt: number,
  now: number,
  heldForMs: number
): boolean {
  const sentAt = run.dispatchedAt ?? runStartedAt
  const rows = (
    run.terminalPaneKey ? evidence.getAgentStatusRowsForPane(run.terminalPaneKey) : []
  ).filter((row) => !row.providerSessionOnly)
  return (
    rows.every((row) => row.state === 'done') &&
    rows.some((row) => isTurnDoneSince(row, sentAt) && now - row.stateStartedAt >= heldForMs)
  )
}
