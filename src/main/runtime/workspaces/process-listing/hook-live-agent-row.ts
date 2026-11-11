import {
  pickParsedAgentStatusPayload,
  pickHostTurnEnd
} from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { RuntimeAgentRowSnapshot } from './runtime-hook-agent-row-selection'

export type HookLiveAgentRow = Pick<
  RuntimeAgentRowSnapshot,
  | 'providerSession'
  | 'payload'
  | 'updatedAt'
  | 'evidenceObservedAt'
  | 'stateStartedAt'
  | 'turnEndedAt'
  | 'turnEndDisposition'
  | 'worktreeId'
  | 'programStatus'
>

export function toHookLiveAgentRow(row: AgentStatusIpcPayload): HookLiveAgentRow {
  return {
    payload: pickParsedAgentStatusPayload(row),
    ...(row.providerSession ? { providerSession: row.providerSession } : {}),
    updatedAt: row.receivedAt,
    ...(row.evidenceObservedAt !== undefined ? { evidenceObservedAt: row.evidenceObservedAt } : {}),
    stateStartedAt: row.stateStartedAt ?? row.receivedAt,
    ...pickHostTurnEnd(row),
    ...(row.worktreeId ? { worktreeId: row.worktreeId } : {}),
    ...(row.programStatus ? { programStatus: row.programStatus } : {})
  }
}
