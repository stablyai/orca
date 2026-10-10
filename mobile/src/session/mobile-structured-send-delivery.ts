import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import { agentSessionRefusalOperationState } from '../../../src/shared/agent-session-refusal-retry'
import { structuredAgentSessionRejectionNotice } from '../../../src/shared/structured-agent-session-rejection-words'
import { dispatchWasWithdrawn } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import {
  readWholeAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../src/shared/agent-session-failure'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { StructuredAgentSessionMutationCallResult } from './mobile-structured-agent-session-rpc'

export type MobileStructuredSendDelivery = {
  outcome: MobileNativeChatSendOutcome
  error: string | null
  failure?: AgentSessionFailureFact
}

export function mobileStructuredSendDelivery(
  result: StructuredAgentSessionMutationCallResult<AgentSessionSendResult>
): MobileStructuredSendDelivery {
  if (result.status === 'unknown') {
    return { outcome: 'unknown', error: null }
  }
  if (result.status === 'refused') {
    return agentSessionRefusalOperationState(result.code) === 'unknown'
      ? { outcome: 'unknown', error: null }
      : { outcome: 'rejected', error: result.message }
  }
  if (result.status !== 'accepted') {
    return { outcome: 'rejected', error: result.message }
  }
  if ('queued' in result.value && result.value.queued) {
    return result.value.queued.state === 'withdrawn'
      ? { outcome: 'rejected', error: 'Message not sent' }
      : { outcome: 'queued', error: null }
  }
  const submission = 'submission' in result.value ? result.value.submission : undefined
  if (!submission || submission.dispatchState === 'unknown') {
    return { outcome: 'unknown', error: null }
  }
  if (submission.queuedMessageId === result.value.clientMessageId) {
    return { outcome: 'unknown', error: null }
  }
  if (submission.dispatchState === 'rejected') {
    if (submission.keptAsQueuedMessageId !== undefined) {
      return { outcome: 'queued', error: null }
    }
    if (submission.queuedMessageId === undefined && dispatchWasWithdrawn(submission)) {
      // The host transcript already owns this send's stopped row.
      return { outcome: 'accepted', error: null }
    }
    const failure = readWholeAgentSessionFailureFact(submission.rejection)
    return {
      outcome: 'rejected',
      error: structuredAgentSessionRejectionNotice(submission.reason, 'composer-send'),
      ...(failure?.kind === 'notSignedIn' ? { failure } : {})
    }
  }
  return { outcome: 'accepted', error: null }
}
