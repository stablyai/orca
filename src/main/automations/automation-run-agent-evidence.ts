import { delayUnlessAborted } from '../../shared/abort-aware-delay'
import {
  ASSISTANT_MESSAGE_RETRY_ATTEMPTS,
  ASSISTANT_MESSAGE_RETRY_MS
} from '../agent-hooks/server/server-constants'
import type { AutomationRun } from '../../shared/automations-types'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  isTurnDoneSince,
  judgeIdleAgentTurn,
  type AgentTurnStatusRow
} from '../agent-turn-idle-verdict'

export { AGENT_START_GRACE_MS } from '../agent-turn-idle-verdict'

type AutomationRunStatusRow = AgentTurnStatusRow &
  Partial<Pick<AgentStatusIpcPayload, 'lastAssistantMessage' | 'lastAssistantMessageIsToolOutput'>>

export type AutomationRunAgentEvidence = {
  getAgentStatusRowsForPane(paneKey: string): readonly AutomationRunStatusRow[]
  /** Executable aliases used to distinguish a launch refusal from ordinary output. */
  agentCommandsForRun(run: AutomationRun): readonly string[]
}

export type IdleRunVerdict =
  | { kind: 'completed' }
  | { kind: 'failed'; error: string }
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
  return verdict.kind === 'failed'
    ? {
        kind: 'failed',
        error: `Automation agent did not start; this host could not run its command (${verdict.missingCommandLine}).`
      }
    : verdict
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

/** The agent's own final reply to this run, when its hooks carried one; a screen tail also holds the prompt and TUI chrome. */
export async function runAssistantReply(
  evidence: AutomationRunAgentEvidence,
  run: AutomationRun,
  runStartedAt: number,
  signal: AbortSignal
): Promise<string | null> {
  const sentAt = run.dispatchedAt ?? runStartedAt
  const readRow = (): AutomationRunStatusRow | undefined =>
    (run.terminalPaneKey ? evidence.getAgentStatusRowsForPane(run.terminalPaneKey) : [])
      .filter((entry) => isTurnDoneSince(entry, sentAt))
      .toSorted((left, right) => right.stateStartedAt - left.stateStartedAt)[0]
  let row = readRow()
  const deadlineAt =
    (row?.stateStartedAt ?? 0) + ASSISTANT_MESSAGE_RETRY_ATTEMPTS * ASSISTANT_MESSAGE_RETRY_MS
  // Hooks can publish done before the final reply flushes; discovery stays in the hook service.
  while (row && !row.lastAssistantMessage && Date.now() < deadlineAt) {
    await delayUnlessAborted(Math.min(ASSISTANT_MESSAGE_RETRY_MS, deadlineAt - Date.now()), signal)
    if (signal.aborted) {
      throw new Error('request_aborted')
    }
    row = readRow()
  }
  // Tool stdout is not the agent's answer.
  return !row?.lastAssistantMessageIsToolOutput && row?.lastAssistantMessage?.trim()
    ? row.lastAssistantMessage
    : null
}
