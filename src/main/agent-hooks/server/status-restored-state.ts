import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { hookLeadTurnState } from '../../../shared/agent-status/lifecycle/hook-lead-turn-state'

const leadTurn = (row: AgentHookEventPayload | undefined) =>
  row ? hookLeadTurnState(row.payload) : null

/** A restart restores a pane's authority (launch token) and lead turn from its saved row, so a
 *  change to either is saved at once rather than with the batched save; a crash must not lose it. */
export function changesRestoredState(
  before: AgentHookEventPayload | undefined,
  after: AgentHookEventPayload | undefined
): boolean {
  return before?.launchToken !== after?.launchToken || leadTurn(before) !== leadTurn(after)
}
