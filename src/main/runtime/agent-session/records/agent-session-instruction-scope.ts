import { createHash } from 'node:crypto'
import {
  agentSessionScopeKey,
  type AgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-record'

export function agentSessionInstructionScope(record: AgentSessionRecord, account: string): string {
  const rewind = record.rewind
  return createHash('sha256')
    .update(
      JSON.stringify([
        record.provider,
        agentSessionScopeKey(record.location),
        record.location.workspaceKind,
        account,
        record.providerContextBoundary ?? null,
        rewind
          ? [
              rewind.operationId,
              rewind.phase,
              rewind.expectedEpoch,
              rewind.epoch ?? null,
              rewind.sequence ?? null,
              rewind.itemId,
              rewind.providerItemId ?? null,
              rewind.contextClearOperationId ?? null
            ]
          : null
      ])
    )
    .digest('hex')
}
