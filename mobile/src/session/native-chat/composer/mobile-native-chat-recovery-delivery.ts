import type { MobileNativeChatSendErrorReporter } from './delivery/use-mobile-native-chat-send-error'
import type { MobileStructuredSendConfirmation } from './delivery/mobile-structured-send-recorded-read'
import type { AgentSessionDeliveryFact } from '../../../../../src/shared/agent-session/requests/structured-agent-session-send-settlement'
import { readWholeAgentSessionFailureFact } from '../../../../../src/shared/agent-session/failures/agent-session-failure'
import { structuredAgentSessionRejectionParts } from '../../../../../src/shared/agent-session/failures/structured-agent-session-rejection-words'
import { mobileAgentSessionWriteNoticeText } from '../agent-session/agent-session-write-notice-copy'
import {
  readMobileNativeChatInFlightSendsByScope,
  settleMobileNativeChatInFlightSend,
  settleRecordedMobileNativeChatInFlightSends
} from './delivery/mobile-native-chat-in-flight-sends'

export function settleMobileInstructionRecovery(
  sessionId: string | null,
  submissions: readonly AgentSessionDeliveryFact[],
  onSendError: MobileNativeChatSendErrorReporter
): void {
  if (!sessionId) {
    return
  }
  const byId = new Map(submissions.map((submission) => [submission.clientMessageId, submission]))
  for (const sends of readMobileNativeChatInFlightSendsByScope().values()) {
    for (const send of sends) {
      if (send.kind !== 'structured' || send.sessionId !== sessionId || !send.clientMessageId) {
        continue
      }
      const submission = byId.get(send.clientMessageId)
      if (
        !submission ||
        submission.dispatchState === 'pending' ||
        submission.dispatchState === 'unknown'
      ) {
        continue
      }
      const fact = readWholeAgentSessionFailureFact(submission.rejection)
      if (submission.dispatchState === 'rejected' && fact?.instructionRecovery) {
        if (!submission.keptAsQueuedMessageId && !submission.queuedMessageId) {
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
            submission.keptAsQueuedMessageId !== undefined ||
            submission.queuedMessageId !== undefined
            ? 'sent'
            : 'kept'
        )
      }
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
  submissions,
  sessionId,
  onSendError
}: {
  confirm: MobileStructuredSendConfirmation | null
  clientMessageId: string
  inFlightIds: () => string[]
  handBack: () => void
  asking: Set<string>
  forget: (ids: ReadonlySet<string>) => void
  submissions: readonly AgentSessionDeliveryFact[]
  sessionId: string | null
  onSendError: MobileNativeChatSendErrorReporter
}): void {
  if (asking.has(clientMessageId)) {
    return
  }
  const asked = confirm?.(clientMessageId)
  if (!asked) {
    handBack()
    return
  }
  asking.add(clientMessageId)
  void asked.then((onHost) => {
    asking.delete(clientMessageId)
    if (onHost.recorded) {
      const facts =
        onHost.submission?.clientMessageId === clientMessageId ? [onHost.submission] : submissions
      settleMobileInstructionRecovery(sessionId, facts, onSendError)
      settleRecordedMobileNativeChatInFlightSends(
        inFlightIds(),
        facts,
        true,
        onHost.ownedByQueue ? [clientMessageId] : []
      )
      forget(new Set([clientMessageId]))
    } else {
      handBack()
    }
  })
}
