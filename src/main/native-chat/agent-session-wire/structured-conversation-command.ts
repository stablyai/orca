import { createHash } from 'node:crypto'
import type {
  AgentSessionConversationCommand,
  AgentSessionConversationCommandRecord,
  AgentSessionConversationCommandResult
} from '../../../shared/agent-session-conversation-command'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import {
  AGENT_SESSION_NOT_ATTACHED,
  admitAgentSessionMutationRequest,
  type AgentSessionMutationAdmissionRequest
} from './structured-agent-session-mutation-admission'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { conversationCommandBlocked } from './structured-conversation-command-admission'

export type ConversationCommandParams = {
  envelope: AgentSessionMutationEnvelope
  command: AgentSessionConversationCommand
}

export type ConversationReplacement = {
  sourceSessionId: string
  sessionId: string
  workspaceId: string
  agent: 'claude' | 'codex'
}

export type PreparedConversationCommand = {
  turn: AgentSessionTurnContext
  prepared: AgentSessionConversationCommandRecord
  source: AgentSessionRecord
  operationCallerKey: string
  supersededOperation: AgentSessionConversationCommandRecord | null
}

export type ConversationCommandResult =
  AgentSessionMutationResult<AgentSessionConversationCommandResult>

export type PendingConversationCommand = {
  key: string
  command: ConversationCommandParams['command']
  operationId: string
  execution: PreparedConversationCommand | null
  promise: Promise<ConversationCommandResult>
  resolve: (result: ConversationCommandResult) => void
  waiterSettled: boolean
}

export type ConversationCommandPreparation =
  | {
      decision: 'return'
      result: AgentSessionMutationResult<AgentSessionConversationCommandResult>
    }
  | { decision: 'execute'; execution: PreparedConversationCommand }

export function conversationCommandExecutionIsCurrent(
  context: StructuredAgentSessionMutationContext,
  execution: PreparedConversationCommand
): boolean {
  const { sessionId, fence, journal } = execution.turn
  const session = context.sessions.get(sessionId)
  const record = context.deps.store.getRecord(sessionId)
  const command = record?.conversationCommand
  return (
    session?.journal === journal &&
    session.fence === fence &&
    record?.lease.runtimeFence === fence &&
    command?.runtimeFence === fence &&
    command.operationId === execution.prepared.operationId &&
    command.callerKey === execution.prepared.callerKey
  )
}

function clearReplacementSessionId(
  sessionId: string,
  callerKey: string,
  operationId: string
): string {
  return `clear-${createHash('sha256')
    .update(JSON.stringify([sessionId, callerKey, operationId]))
    .digest('hex')
    .slice(0, 40)}`
}

function matchingCommand(
  context: StructuredAgentSessionMutationContext,
  callerKey: string,
  params: ConversationCommandParams
): AgentSessionConversationCommandRecord | null {
  const command = context.deps.store.getRecord(params.envelope.sessionId)?.conversationCommand
  if (
    command?.operationId === params.envelope.clientOperationId &&
    command.callerKey === callerKey
  ) {
    return command
  }
  return params.command === 'clear' &&
    command?.command === 'clear' &&
    command.replacementSessionId ===
      clearReplacementSessionId(
        params.envelope.sessionId,
        callerKey,
        params.envelope.clientOperationId
      )
    ? command
    : null
}

function mutationRequest(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: ConversationCommandParams
): AgentSessionMutationAdmissionRequest<AgentSessionConversationCommandResult> {
  const { command, envelope } = params
  const { sessionId } = envelope
  return {
    store: context.deps.store,
    adapter: context.deps.adapter,
    callerKey: caller.callerKey,
    envelope,
    journal: context.sessions.get(sessionId)?.journal,
    publish: (journal) => context.publish(sessionId, journal),
    flushStreamedEvents: context.flushStreamedEvents,
    now: context.now,
    plan: {
      method: 'agentSession.conversationCommand',
      fields: { command },
      recoverUnknownFromDurableState: true,
      replay: (_ctx, outcome) => {
        if (outcome.status === 'succeeded' && outcome.conversationCommand) {
          return outcome.conversationCommand
        }
        const prior = matchingCommand(context, caller.callerKey, params)
        if (prior?.phase === 'committed') {
          return prior
        }
        if (command === 'compact' && prior && outcome.status !== 'unknown') {
          return {
            command,
            state: 'unknown',
            error: 'Compaction completion is unconfirmed; it was not run again.'
          }
        }
        return outcome.status === 'succeeded' && command === 'compact'
          ? { command, state: 'completed' }
          : null
      },
      rerunWhenReplayMissing: () =>
        command === 'clear' &&
        matchingCommand(context, caller.callerKey, params)?.phase === 'prepared'
    }
  }
}

async function recordRefusal(
  context: StructuredAgentSessionMutationContext,
  operationCallerKey: string,
  operationId: string,
  refusal: AgentSessionWireRefusal
): Promise<void> {
  await context.deps.store.recordOperationOutcome({
    callerKey: operationCallerKey,
    operationId,
    outcome: { status: 'failed', code: refusal.code, message: refusal.message }
  })
}

/** Admit and durably prepare on the session lane. Provider work starts only after this returns. */
export async function prepareStructuredConversationCommand(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: ConversationCommandParams
): Promise<ConversationCommandPreparation> {
  const admitted = await admitAgentSessionMutationRequest(mutationRequest(context, caller, params))
  if (admitted.decision === 'return') {
    return { decision: 'return', result: admitted.result }
  }
  const { command, envelope } = params
  const { sessionId, clientOperationId } = envelope
  const store = context.deps.store
  const source = store.getRecord(sessionId)
  if (!source) {
    const refusal = AGENT_SESSION_NOT_ATTACHED
    await recordRefusal(context, admitted.operationCallerKey, clientOperationId, refusal)
    return { decision: 'return', result: { ok: false, refusal } }
  }
  const interruptedClear = source.conversationCommand
  const matching = matchingCommand(context, caller.callerKey, params)
  const prior =
    matching ??
    (command === 'clear' &&
    interruptedClear?.command === 'clear' &&
    interruptedClear.phase === 'prepared' &&
    interruptedClear.runtimeFence !== admitted.context.fence
      ? interruptedClear
      : null)
  const blocked =
    prior?.phase === 'prepared' && command === 'clear'
      ? null
      : conversationCommandBlocked(admitted.context, source)
  if (blocked) {
    const refusal = { code: 'agent_session_operation_invalid' as const, message: blocked }
    await recordRefusal(context, admitted.operationCallerKey, clientOperationId, refusal)
    return { decision: 'return', result: { ok: false, refusal } }
  }
  const replacementSessionId =
    command === 'clear'
      ? (prior?.replacementSessionId ??
        clearReplacementSessionId(sessionId, caller.callerKey, clientOperationId))
      : undefined
  const prepared: AgentSessionConversationCommandRecord = {
    command,
    runtimeFence: admitted.context.fence,
    operationId: clientOperationId,
    callerKey: caller.callerKey,
    phase: 'prepared',
    state: 'unknown',
    ...(replacementSessionId ? { replacementSessionId } : {})
  }
  try {
    await store.setConversationCommand(sessionId, admitted.context.fence, prepared)
  } catch (error) {
    await store.recordOperationOutcome({
      callerKey: admitted.operationCallerKey,
      operationId: clientOperationId,
      outcome: { status: 'unknown' }
    })
    throw error
  }
  return {
    decision: 'execute',
    execution: {
      turn: admitted.context,
      prepared,
      source,
      operationCallerKey: admitted.operationCallerKey,
      supersededOperation: prior && prior.operationId !== clientOperationId ? prior : null
    }
  }
}

export async function persistConversationCommandResult(
  context: StructuredAgentSessionMutationContext,
  execution: PreparedConversationCommand,
  value: AgentSessionConversationCommandRecord
): Promise<void> {
  const { prepared, operationCallerKey, supersededOperation, turn } = execution
  await context.deps.store.setConversationCommand(turn.sessionId, turn.fence, value)
  await context.deps.store.recordOperationOutcome({
    callerKey: operationCallerKey,
    operationId: prepared.operationId,
    outcome: { status: 'succeeded', sessionId: turn.sessionId, conversationCommand: value }
  })
  if (supersededOperation) {
    await context.deps.store.recordOperationOutcome({
      callerKey: supersededOperation.callerKey,
      operationId: supersededOperation.operationId,
      outcome: { status: 'succeeded', sessionId: turn.sessionId, conversationCommand: value }
    })
  }
}

export function conversationCommandResult(
  execution: PreparedConversationCommand,
  value: AgentSessionConversationCommandResult
): AgentSessionMutationResult<AgentSessionConversationCommandResult> {
  return {
    ok: true,
    replayed: false,
    fence: execution.turn.fence,
    cursor: execution.turn.journal.cursor(),
    value
  }
}
