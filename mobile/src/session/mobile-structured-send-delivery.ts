import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import { agentSessionRefusalOperationState } from '../../../src/shared/agent-session-refusal-retry'
import type { MobileNativeChatSendOutcome } from './native-chat/mobile-native-chat-send'
import type { StructuredAgentSessionMutationCallResult } from './mobile-structured-agent-session-rpc'
import { translate } from '../i18n/mobile-i18n'

export type MobileStructuredSendDelivery = {
  outcome: MobileNativeChatSendOutcome
  error: string | null
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
      ? {
          outcome: 'rejected',
          error: translate('session.structuredSendDelivery.messageNotSent', 'Message not sent')
        }
      : { outcome: 'queued', error: null }
  }
  const submission = 'submission' in result.value ? result.value.submission : undefined
  if (!submission || submission.dispatchState === 'unknown') {
    return { outcome: 'unknown', error: null }
  }
  if (submission.queuedMessageId === result.value.clientMessageId) {
    return { outcome: 'unknown', error: null }
  }
  // Recorded rejections stay in history rather than returning to the composer; requeued submissions belong to their cards.
  if (submission.dispatchState === 'rejected' && submission.keptAsQueuedMessageId !== undefined) {
    return { outcome: 'queued', error: null }
  }
  return { outcome: 'accepted', error: null }
}
