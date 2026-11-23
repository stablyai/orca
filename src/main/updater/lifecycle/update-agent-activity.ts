import { isLocalHookConnectionId } from '../../../shared/agent-hook-listener/transport/wsl-hook-relay-contract'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'

export function hasWorkingUpdateAgents(rows: readonly AgentStatusIpcPayload[]): boolean {
  return rows.some(
    (row) =>
      (row.connectionId == null || isLocalHookConnectionId(row.connectionId)) &&
      !row.providerSessionOnly &&
      !row.restoredUnconfirmed &&
      row.state !== 'done'
  )
}
