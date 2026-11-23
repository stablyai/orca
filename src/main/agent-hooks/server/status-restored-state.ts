import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { hookLeadTurnState } from '../../../shared/agent-status/lifecycle/hook-lead-turn-state'

const leadTurn = (row: AgentHookEventPayload | undefined) =>
  row ? hookLeadTurnState(row.payload) : null

/** Which part of a pane's saved row a restart restores changed: its authority (launch token) or
 *  its lead turn. Either must survive a crash, so neither waits for the batched save. */
function restoredStateEdge(
  before: AgentHookEventPayload | undefined,
  after: AgentHookEventPayload | undefined
): 'authority' | 'turn' | null {
  if (before?.launchToken !== after?.launchToken) {
    return 'authority'
  }
  return leadTurn(before) !== leadTurn(after) ? 'turn' : null
}

export type RestoredStateRevisions = Record<'authority' | 'turn', number>

/** Counts a row mutation's restored-state edge, which schedules its save ahead of the batch. */
export function countRestoredStateEdge(
  revisions: RestoredStateRevisions,
  before: AgentHookEventPayload | undefined,
  after: AgentHookEventPayload | undefined
): void {
  const edge = restoredStateEdge(before, after)
  if (edge) {
    revisions[edge]++
  }
}
