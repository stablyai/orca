// What one `agentSession.send` answer means to a client with no outbox.
//
// The desktop reads the same four dispatch states through
// `disposeStructuredAgentSessionSendResult`; mobile has no queue to move, so it
// needs only the outcome to report. Each press sends under its own operation
// id, so no answer here decides whether a later press may reuse one.

import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import { agentSessionRefusalOperationState } from '../../../src/shared/agent-session-refusal-retry'
import { structuredAgentSessionRejectionNotice } from '../../../src/shared/structured-agent-session-send-disposition'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { StructuredAgentSessionMutationCallResult } from './mobile-structured-agent-session-rpc'

export type MobileStructuredSendDelivery = {
  outcome: MobileNativeChatSendOutcome
  /** Copy for the user, or null when the outcome needs none. */
  error: string | null
}

export function mobileStructuredSendDelivery(
  result: StructuredAgentSessionMutationCallResult<AgentSessionSendResult>
): MobileStructuredSendDelivery {
  if (result.status === 'unknown') {
    return { outcome: 'unknown', error: null }
  }
  if (result.status === 'refused' && agentSessionRefusalOperationState(result.code) === 'unknown') {
    return { outcome: 'unknown', error: null }
  }
  if (result.status !== 'accepted') {
    return { outcome: 'rejected', error: result.message }
  }
  if ('queued' in result.value && result.value.queued) {
    // The host holds (or already settled) the draft. A withdrawn replay is accepted too,
    // never unknown: its card was deleted or carried by a /clear.
    return { outcome: 'accepted', error: null }
  }
  const submission: AgentJournalSubmission | undefined =
    'submission' in result.value ? result.value.submission : undefined
  if (!submission || submission.dispatchState === 'unknown') {
    return { outcome: 'unknown', error: null }
  }
  if (submission.dispatchState === 'rejected') {
    return {
      outcome: 'rejected',
      error: structuredAgentSessionRejectionNotice(submission.reason, 'composer-send')
    }
  }
  return { outcome: 'accepted', error: null }
}
