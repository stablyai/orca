// A conversation's turn is named by the host's stamp on its agent's hook row, wherever that stamp exists.
import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { hookRowAgentPhase } from '../../shared/agent-transitions'

/**
 * The stamped turn a working row shows, however it got there: prompt news, a new prompt after a dismissed
 * approval, or a stamp landing on a row already working. Null for other rows.
 */
export function workingStampedTurn(row: AgentStatusIpcPayload | null): number | null {
  if (!row || row.structuredHost || hookRowAgentPhase(row) !== 'working') {
    return null
  }
  return row.turnStartedAt ?? null
}
