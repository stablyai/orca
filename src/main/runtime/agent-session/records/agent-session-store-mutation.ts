import { commitAgentSessionRewindCompletion } from '../agent-session-rewind-completion'
import type { AgentSessionRewindRecord } from '../../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  applyAgentSessionStoreCommand,
  agentSessionStoreCommandSelection,
  type AgentSessionStoreCommand
} from './agent-session-store-command'
import type {
  AgentSessionForkedFrom,
  AgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionOperationOutcome } from '../../../../shared/agent-session/lifecycle/operations/agent-session-operation-ledger'
import { agentSessionOperationKey } from '../../../../shared/agent-session/lifecycle/operations/agent-session-operation-ledger'
import type { UsageLimitContinueIdentity } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-usage-limit-continue'
import { cancelAgentSessionUsageLimitContinue } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-usage-limit-continue'
import {
  insertAcceptedAgentSessionOperationInto,
  settleAgentSessionOperationInto,
  type AgentSessionOperationAcceptance
} from '../ownership/agent-session-operation-admission'
import {
  commitConversationClearRecord,
  type AgentSessionConversationClear
} from './agent-session-conversation-command-record'
import {
  requireWritableAgentSessionRecord,
  type AgentSessionStoreState
} from './agent-session-store-state'
import {
  applyAgentSessionRecordCommand,
  type AgentSessionRecordCommand
} from './agent-session-record-command'

export type AgentSessionOperationMutation =
  | (AgentSessionOperationAcceptance & { outcome: AgentSessionOperationOutcome })
  | Parameters<typeof settleAgentSessionOperationInto>[1]

export type AgentSessionRecordAcceptance =
  | { kind: 'validated-plan' }
  | { kind: 'stop-continue'; enabled: boolean }

export type AgentSessionStoreMutation =
  | {
      kind: 'rewind-complete'
      sessionId: string
      fence: number
      rewind: AgentSessionRewindRecord
      childBoundary?: NonNullable<AgentSessionRecord['forkedFrom']>['childBoundary']
    }
  | { kind: 'command'; command: AgentSessionStoreCommand }
  | { kind: 'record'; sessionId: string; command: AgentSessionRecordCommand }
  | {
      kind: 'operation'
      operation: AgentSessionOperationMutation
      record?: { sessionId: string; action: AgentSessionRecordAcceptance }
      wakeSessionId?: string
    }
  | { kind: 'fork-boundary'; sessionId: string; forkedFrom: AgentSessionForkedFrom }
  | {
      kind: 'clear'
      clear: AgentSessionConversationClear
      operation: { callerKey: string; operationId: string }
    }
  | { kind: 'cancel-continue'; sessionId: string; cut: UsageLimitContinueIdentity }
  | { kind: 'submission-wake'; sessionId: string }

export function agentSessionStoreMutationKeys(mutation: AgentSessionStoreMutation): {
  recordIds: string[]
  operationId?: string
  operationKey?: string
  allCallers?: boolean
  adoptedNativeId?: string
  legacyRecordIds?: readonly string[]
  missingPermission?: boolean
  tabs?: boolean
  pruneAt?: number
} {
  if (mutation.kind === 'command') {
    const selection = agentSessionStoreCommandSelection(mutation.command)
    const operation = selection.operation
    return {
      ...selection,
      operationId: operation?.operationId,
      operationKey: operation?.callerKey
        ? agentSessionOperationKey(operation.callerKey, operation.operationId)
        : undefined
    }
  }
  const operation =
    mutation.kind === 'operation' || mutation.kind === 'clear'
      ? mutation.operation
      : mutation.kind === 'rewind-complete'
        ? { callerKey: mutation.rewind.callerKey, operationId: mutation.rewind.operationId }
        : undefined
  const recordIds =
    mutation.kind === 'operation'
      ? [mutation.record?.sessionId, mutation.wakeSessionId].filter(
          (id): id is string => id !== undefined
        )
      : [mutation.kind === 'clear' ? mutation.clear.sessionId : mutation.sessionId]
  return {
    recordIds: [...new Set(recordIds)],
    operationId: operation?.operationId,
    operationKey: operation?.callerKey
      ? agentSessionOperationKey(operation.callerKey, operation.operationId)
      : undefined,
    allCallers:
      operation !== undefined &&
      (!operation.callerKey ||
        ('operationIdScope' in operation && operation.operationIdScope === 'global'))
  }
}

/** A local source group operates on exact current rows, then discards its decoded state. */
export function applyAgentSessionStoreMutation(
  state: AgentSessionStoreState,
  mutation: AgentSessionStoreMutation,
  at: number | undefined,
  facts: {
    planMode?: 'default' | 'plan'
    continueCut?: UsageLimitContinueIdentity
    cursor?: AgentJournalCursor
  } = {}
): unknown {
  switch (mutation.kind) {
    case 'rewind-complete':
      if (!facts.cursor) {
        throw new Error('rewind completion requires its current journal cursor')
      }
      return commitAgentSessionRewindCompletion(
        state,
        mutation.sessionId,
        mutation.fence,
        mutation.rewind,
        facts.cursor,
        facts.continueCut,
        mutation.childBoundary
      )
    case 'command':
      return applyAgentSessionStoreCommand(state, mutation.command)
    case 'record': {
      const applied = applyAgentSessionRecordCommand(
        requireWritableAgentSessionRecord(state, mutation.sessionId),
        mutation.command
      )
      state.records.set(mutation.sessionId, applied.record)
      return applied.result
    }
    case 'operation':
      if ('fingerprint' in mutation.operation) {
        insertAcceptedAgentSessionOperationInto(state, mutation.operation)
      } else {
        settleAgentSessionOperationInto(state, mutation.operation)
      }
      if (mutation.record) {
        const { sessionId, action } = mutation.record
        if (action.kind === 'stop-continue' && action.enabled && facts.continueCut) {
          cancelContinue(state, sessionId, facts.continueCut)
        } else if (action.kind === 'validated-plan') {
          const record = state.records.get(sessionId)
          const mode = facts.planMode
          if (
            record?.provider === 'claude' &&
            mode !== undefined &&
            (mode !== 'default' || record.options?.interactionMode === 'plan') &&
            record.options?.interactionMode !== mode
          ) {
            state.records.set(sessionId, {
              ...record,
              options: { ...record.options, interactionMode: mode }
            })
          }
        }
      }
      if (mutation.wakeSessionId) {
        wake(state, mutation.wakeSessionId, at)
      }
      return
    case 'fork-boundary': {
      const record = state.records.get(mutation.sessionId)
      if (!record) {
        throw new Error('agent_session_fork:record-missing')
      }
      state.records.set(record.sessionId, { ...record, forkedFrom: mutation.forkedFrom })
      return
    }
    case 'clear':
      commitConversationClearRecord(state, mutation.clear)
      settleAgentSessionOperationInto(state, {
        ...mutation.operation,
        outcome: {
          status: 'succeeded',
          sessionId: mutation.clear.sessionId,
          conversationCommand: mutation.clear.command
        }
      })
      return
    case 'cancel-continue':
      cancelContinue(state, mutation.sessionId, mutation.cut)
      return
    case 'submission-wake':
      return wake(state, mutation.sessionId, at)
  }
}

function cancelContinue(
  state: AgentSessionStoreState,
  sessionId: string,
  cut: UsageLimitContinueIdentity
) {
  const record = state.records.get(sessionId)
  if (record) {
    state.records.set(sessionId, cancelAgentSessionUsageLimitContinue(record, cut))
  }
}

function wake(state: AgentSessionStoreState, sessionId: string, at: number | undefined) {
  const record: AgentSessionRecord = requireWritableAgentSessionRecord(state, sessionId)
  if (record.sleptAt !== undefined) {
    const { sleptAt: _sleptAt, ...awake } = record
    state.records.set(sessionId, { ...awake, updatedAt: at ?? record.updatedAt })
  }
}
