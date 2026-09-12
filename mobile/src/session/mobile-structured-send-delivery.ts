// What one `agentSession.send` answer means to a client with no outbox.
//
// The desktop reads the same four dispatch states through
// `disposeStructuredAgentSessionSendResult`; mobile has no queue to move, so it
// needs only two facts: the outcome to report, and whether the operation id it
// sent under is spent.
//
// The id is the whole safety mechanism here. Mobile keys its retained ids by
// message body, so re-sending the same text reuses the id — and one id is one
// delivery: `performSend` answers a second request under a recorded id from the
// ledger and never puts it back on the wire. Releasing the id turns that replay
// into a genuine second delivery, which is why only a settled answer releases it:
//
//   accepted/pending — the send happened. The id is spent; a later identical
//     message is a new message and must carry a new id.
//   rejected — provably did not happen, and terminal in the reducer. Reusing the
//     id could only replay that rejection forever, so it is spent too; the next
//     attempt is a first delivery under a fresh id and cannot duplicate.
//   unknown — the one answer that KEEPS its id, whether it came from the host or
//     from an ack-loss on the way back. The message may be with the provider, so
//     the retry has to stay a replay. Rotating here is what sent one message to a
//     model five times.

import type { AgentSessionSendResult } from '../../../src/shared/agent-session-wire'
import { structuredAgentSessionRejectionNotice } from '../../../src/shared/structured-agent-session-send-disposition'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { StructuredAgentSessionMutationCallResult } from './mobile-structured-agent-session-rpc'

export type MobileStructuredSendDelivery = {
  outcome: MobileNativeChatSendOutcome
  /** True when a further send under the same operation id could only replay this answer. */
  operationIdSpent: boolean
  /** Copy for the user, or null when the outcome needs none. */
  error: string | null
}

export function mobileStructuredSendDelivery(
  result: StructuredAgentSessionMutationCallResult<AgentSessionSendResult>
): MobileStructuredSendDelivery {
  if (result.status === 'unknown') {
    return { outcome: 'unknown', operationIdSpent: false, error: null }
  }
  if (result.status !== 'accepted') {
    return {
      outcome: 'rejected',
      operationIdSpent: true,
      error: result.message === 'Request not sent' ? 'Message not sent' : result.message
    }
  }
  // A host that answered without a submission row claims nothing about dispatch;
  // treat it as the acknowledgement it has always been rather than inventing doubt.
  const submission = result.value.submission as AgentSessionSendResult['submission'] | undefined
  if (submission?.dispatchState === 'unknown') {
    return { outcome: 'unknown', operationIdSpent: false, error: null }
  }
  if (submission?.dispatchState === 'rejected') {
    return {
      outcome: 'rejected',
      operationIdSpent: true,
      error: structuredAgentSessionRejectionNotice(submission.reason)
    }
  }
  return { outcome: 'accepted', operationIdSpent: true, error: null }
}
