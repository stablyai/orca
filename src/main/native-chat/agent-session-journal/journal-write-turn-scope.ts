import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { JournalReducerState } from './journal-reducer'
import { journalExecutionAlias } from './journal-execution-item'

/** Provider scopes bind once at ingress; captured host scopes already name their execution. */
export function journalWriteTurnScope(
  state: JournalReducerState,
  scope: AgentJournalTurnScope,
  ownerFence: number,
  exact: boolean
): AgentJournalTurnScope {
  if (scope.kind !== 'turn' || (exact && state.items.has(scope.turnItemId))) {
    return scope
  }
  const itemId =
    state.aliases.get(journalExecutionAlias(scope.turnItemId, ownerFence)) ??
    state.aliases.get(scope.turnItemId) ??
    scope.turnItemId
  return itemId === scope.turnItemId ? scope : { kind: 'turn', turnItemId: itemId }
}
