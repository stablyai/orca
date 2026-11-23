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

/** Authority edges as a revision (they save everything at once) and the panes whose lead turn
 *  changed since their row was saved (only those rows save ahead of the batch). */
export type RestoredStateEdges = { authority: number; turnKeys: Set<string> }

/** Records a row mutation's restored-state edge, which schedules its save ahead of the batch. */
export function noteRestoredStateEdge(
  edges: RestoredStateEdges,
  paneKey: string,
  before: AgentHookEventPayload | undefined,
  after: AgentHookEventPayload | undefined
): void {
  const edge = restoredStateEdge(before, after)
  if (edge === 'authority') {
    edges.authority++
  } else if (edge === 'turn') {
    edges.turnKeys.add(paneKey)
  }
}
