import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import {
  pickHostTurnEnd,
  pickParsedAgentStatusPayload
} from '../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeAgentRowSnapshot } from './runtime-hook-agent-row-selection'

export type HookLiveAgentRow = Pick<
  RuntimeAgentRowSnapshot,
  | 'payload'
  | 'updatedAt'
  | 'evidenceObservedAt'
  | 'stateStartedAt'
  | 'turnEndedAt'
  | 'turnEndDisposition'
  | 'worktreeId'
  | 'programStatus'
  | 'paneSleep'
>

export function toHookLiveAgentRow(row: AgentStatusIpcPayload): HookLiveAgentRow {
  return {
    payload: pickParsedAgentStatusPayload(row),
    updatedAt: row.receivedAt,
    ...(row.evidenceObservedAt !== undefined ? { evidenceObservedAt: row.evidenceObservedAt } : {}),
    stateStartedAt: row.stateStartedAt ?? row.receivedAt,
    ...pickHostTurnEnd(row),
    ...(row.worktreeId ? { worktreeId: row.worktreeId } : {}),
    ...(row.programStatus ? { programStatus: row.programStatus } : {}),
    ...(row.paneSleep ? { paneSleep: row.paneSleep } : {})
  }
}
