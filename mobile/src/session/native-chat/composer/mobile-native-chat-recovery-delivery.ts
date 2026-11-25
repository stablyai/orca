import type { MobileNativeChatSendErrorReporter } from './delivery/use-mobile-native-chat-send-error'
import type { MobileStructuredSendConfirmation } from './delivery/mobile-structured-send-recorded-read'
import type { AgentSessionDeliveryFact } from '../../../../../src/shared/agent-session/requests/structured-agent-session-send-settlement'
import { readWholeAgentSessionFailureFact } from '../../../../../src/shared/agent-session/failures/agent-session-failure'
import { structuredAgentSessionRejectionParts } from '../../../../../src/shared/agent-session/failures/structured-agent-session-rejection-words'
import { mobileAgentSessionWriteNoticeText } from '../agent-session/agent-session-write-notice-copy'
import {
  readMobileNativeChatInFlightStructuredSession,
  mobileRecoveryQueueOwns,
  releaseMobileNativeChatInFlightSends,
  settleMobileNativeChatInFlightSend,
  settleRecordedMobileNativeChatInFlightSends
} from './delivery/mobile-native-chat-in-flight-sends'

export function settleMobileInstructionRecovery(
  sessionId: string | null,
  submissions: readonly AgentSessionDeliveryFact[],
  onSendError: MobileNativeChatSendErrorReporter,
  queuedMessageIds: readonly string[]
): void {
  if (!sessionId || submissions.length === 0) {
    return
  }
  const sends = readMobileNativeChatInFlightStructuredSession(sessionId)
  if (sends.length === 0) {
    return
  }
  const byId = new Map(submissions.map((submission) => [submission.clientMessageId, submission]))
  const queued = new Set(queuedMessageIds)
  for (const send of sends) {
    const submission = send.clientMessageId && byId.get(send.clientMessageId)
    if (
      !submission ||
      submission.dispatchState === 'pending' ||
      submission.dispatchState === 'unknown'
    ) {
      continue
    }
    const fact = readWholeAgentSessionFailureFact(submission.rejection)
    if (submission.dispatchState === 'rejected' && fact?.instructionRecovery) {
      if (!queued.has(submission.clientMessageId) && !mobileRecoveryQueueOwns(submission, queued)) {
        continue
      }
      settleMobileNativeChatInFlightSend(send.id, 'sent')
      const message = mobileAgentSessionWriteNoticeText(
        structuredAgentSessionRejectionParts(submission.reason, 'send', fact, {
          agentName: 'Codex'
        })
      )
      onSendError(message, { announceOnly: true })
    } else {
      settleMobileNativeChatInFlightSend(
        send.id,
        submission.dispatchState === 'accepted' ||
          queued.has(submission.clientMessageId) ||
          mobileRecoveryQueueOwns(submission, queued)
          ? 'sent'
          : 'kept'
      )
    }
  }
}

export function confirmMobileRecordedRecovery({
  confirm,
  clientMessageId,
  inFlightIds,
  handBack,
  asking,
  forget,
  readDelivery,
  sessionId,
  onSendError
}: {
  confirm: MobileStructuredSendConfirmation | null
  clientMessageId: string
  inFlightIds: () => string[]
  handBack: () => void
  asking: Set<string>
  forget: (ids: ReadonlySet<string>) => void
  readDelivery: () => {
    submissions: readonly AgentSessionDeliveryFact[]
    queuedMessageIds: readonly string[]
  } | null
  sessionId: string | null
  onSendError: MobileNativeChatSendErrorReporter
}): void {
  if (asking.has(clientMessageId)) {
    return
  }
  const returnIfUnowned = () => {
    const current = readDelivery()
    if (
      current &&
      !current.submissions.some((entry) => entry.clientMessageId === clientMessageId) &&
      !current.queuedMessageIds.includes(clientMessageId)
    ) {
      handBack()
    }
  }
  const asked = confirm?.(clientMessageId)
  if (!asked) {
    returnIfUnowned()
    releaseMobileNativeChatInFlightSends(inFlightIds())
    return
  }
  asking.add(clientMessageId)
  void asked.then((onHost) => {
    asking.delete(clientMessageId)
    if (onHost.recorded) {
      const facts =
        onHost.submission?.clientMessageId === clientMessageId
          ? [onHost.submission]
          : (readDelivery()?.submissions ?? [])
      const queuedMessageIds = onHost.ownedByQueue ? [clientMessageId] : []
      settleMobileInstructionRecovery(sessionId, facts, onSendError, queuedMessageIds)
      settleRecordedMobileNativeChatInFlightSends(inFlightIds(), facts, true, queuedMessageIds)
      forget(new Set([clientMessageId]))
    } else if (onHost.confirmedAbsent) {
      returnIfUnowned()
    }
    releaseMobileNativeChatInFlightSends(inFlightIds())
  })
}
