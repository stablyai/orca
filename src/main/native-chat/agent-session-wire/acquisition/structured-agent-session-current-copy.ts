import {
  canonicalAgentSessionDigest,
  agentSessionLedgerRefusal
} from '../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { parseAgentSessionOperationTimestamp } from '../../../../shared/agent-session/lifecycle/operations/agent-session-host-authority'
import {
  AgentSessionRefusalError,
  isAgentSessionRefusalError,
  agentSessionRefusalFromReference,
  readAgentSessionRefusalReference
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import {
  AgentConversationCopyError,
  agentConversationCopyRefusal
} from '../../conversation-adoption/agent-conversation-copy-error'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { StructuredAgentSessionConversationCopyInput } from '../providers/structured-agent-session-conversation-copy-input'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import {
  readNativeCopyCoverage,
  type NativeCopyCoverage
} from '../../agent-session-journal/context-epochs/journal-history-origin'

/** The native copy has its own receipt because it happens before the destination chat exists. */
export async function copyStructuredAgentSessionCurrentContext(input: {
  store: AgentSessionRecordStore
  callerKey: string
  envelope: { sessionId: string; clientOperationId: string }
  permission: 'inherit'
  source: StructuredAgentSessionConversationCopyInput
  copy: NonNullable<StructuredAgentSessionAdapter['copyConversation']>
}) {
  const timestamp = parseAgentSessionOperationTimestamp(input.envelope.clientOperationId)
  if (timestamp === null) {
    throw agentConversationCopyRefusal(
      'agent_session_operation_invalid',
      { reason: 'requestMalformed' },
      'This side-chat request has no durable operation id.'
    )
  }
  const operationId = `${timestamp}-${canonicalAgentSessionDigest({
    child: 'agentSession.create:current-copy',
    operationId: input.envelope.clientOperationId
  }).slice(0, 32)}`
  const record = input.source.record
  const decision = await input.store.admitGlobalOperation({
    callerKey: input.callerKey,
    operationId,
    fingerprint: canonicalAgentSessionDigest({
      sessionId: input.envelope.sessionId,
      permission: input.permission,
      identity: input.source.identity,
      providerSessionId: input.source.providerSessionId,
      accountHome: input.source.accountHome,
      contextBoundary: record?.providerContextBoundary
    }),
    now: Date.now()
  })
  if (decision.decision === 'refused') {
    throw new AgentSessionRefusalError(
      agentSessionLedgerRefusal({ clientOperationId: operationId }, decision)
    )
  }
  const outcome = decision.row.outcome
  if (outcome.status === 'failed') {
    const reference = readAgentSessionRefusalReference(outcome)
    if (reference) {
      const message = outcome.message ?? 'The original copy was refused.'
      const error = new AgentSessionRefusalError(
        agentSessionRefusalFromReference(reference, message),
        {
          cause: new AgentConversationCopyError(message)
        }
      )
      error.refusal.createAttemptRefusedBeforeCommit = true
      throw error
    }
  }
  const copiedSessionId = outcome.status === 'succeeded' ? outcome.sessionId : undefined
  const savedCoverage =
    outcome.status === 'succeeded' && outcome.conversationCopyCoverage !== undefined
      ? readNativeCopyCoverage(outcome.conversationCopyCoverage)
      : undefined
  if (savedCoverage === null) {
    throw agentConversationCopyRefusal(
      'agent_session_operation_unknown',
      { reason: 'outcomeUnknown' },
      'The saved side-chat context could not be confirmed. Check its history before continuing.'
    )
  }
  const claim = copiedSessionId
    ? null
    : await input.store.claimOperation({
        callerKey: decision.row.callerKey,
        operationId
      })
  if (!copiedSessionId && claim?.claim !== 'won') {
    throw agentConversationCopyRefusal(
      'agent_session_operation_unknown',
      { reason: 'outcomeUnknown' },
      'The agent could not confirm the original copy. Check its history before opening another side chat.'
    )
  }
  const rememberCopy = async (
    sessionId: string,
    coverage: NativeCopyCoverage | undefined = savedCoverage
  ) => {
    if (!sessionId.trim() || sessionId === input.source.providerSessionId) {
      throw new Error('The provider did not confirm an independent copy.')
    }
    await input.store.recordOperationOutcome({
      callerKey: decision.row.callerKey,
      operationId,
      outcome: {
        status: 'succeeded',
        sessionId,
        ...(coverage ? { conversationCopyCoverage: coverage } : {})
      }
    })
  }
  try {
    const copy = await input.copy({
      ...input.source,
      copiedSessionId,
      ...(savedCoverage ? { copiedCoverage: savedCoverage } : {}),
      onCopyConfirmed: rememberCopy
    })
    await rememberCopy(copy.sessionId, copy.coverage)
    return copy
  } catch (error) {
    if (isAgentSessionRefusalError(error) && error.refusal.createAttemptRefusedBeforeCommit) {
      await input.store.recordOperationOutcome({
        callerKey: decision.row.callerKey,
        operationId,
        outcome: {
          status: 'failed',
          code: error.refusal.code,
          message: error.refusal.message,
          details: error.refusal.details
        }
      })
    }
    throw error
  }
}
