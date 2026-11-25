import type { MobileNativeChatSendErrorReporter } from './delivery/use-mobile-native-chat-send-error'
import type {
  MobileStructuredSendConfirmation,
  MobileStructuredSendRecord
} from './delivery/mobile-structured-send-recorded-read'
import {
  structuredAgentSessionReadCoversSend,
  type AgentSessionDeliveryFact
} from '../../../../../src/shared/agent-session/requests/structured-agent-session-send-settlement'
import type { AgentJournalCursor } from '../../../../../src/shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import { handedOffQueuedMessageIds } from '../../../../../src/shared/agent-session/view/structured-agent-session-draft-hand-off'
import { STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING } from '../../../../../src/shared/agent-session/requests/structured-agent-session-send-evidence'
import type { StructuredAgentSessionOptimisticMessage } from '../../../../../src/shared/agent-session/view/structured-agent-session-message-projection'
import type { UnconfirmedSendDeadlines } from './delivery/unconfirmed-send-deadlines'
import { structuredAgentSessionRejectionParts } from '../../../../../src/shared/agent-session/failures/structured-agent-session-rejection-words'
import { mobileAgentSessionWriteNoticeText } from '../agent-session/agent-session-write-notice-copy'
import { deferMobileNativeChatRecoveryNotice } from './delivery/mobile-native-chat-deferred-recovery-notices'
import {
  readMobileNativeChatInFlightStructuredSession,
  markMobileNativeChatInFlightUnconfirmed,
  mobileNativeChatInFlightClaim,
  notifyMobileNativeChatInFlightChange,
  readMobileNativeChatInFlightSend,
  releaseMobileNativeChatInFlightSends,
  settleRecordedMobileNativeChatInFlightSends
} from './delivery/mobile-native-chat-in-flight-sends'
import { UNCONFIRMED_SEND_MESSAGE } from './delivery/use-mobile-native-chat-unconfirmed-sends'

export function settleMobileInstructionRecovery(
  sessionId: string | null,
  submissions: readonly AgentSessionDeliveryFact[],
  onSendError: MobileNativeChatSendErrorReporter,
  queuedMessageIds: readonly string[],
  ids?: readonly string[]
): Set<string> | undefined {
  if (!sessionId || (!submissions.length && !queuedMessageIds.length)) {
    return
  }
  const sends = ids ?? readMobileNativeChatInFlightStructuredSession(sessionId).map(({ id }) => id)
  if (!sends.length) {
    return
  }
  return settleRecordedMobileNativeChatInFlightSends(
    sends,
    submissions,
    queuedMessageIds,
    (scope, fact, reason) => {
      const message = mobileAgentSessionWriteNoticeText(
        structuredAgentSessionRejectionParts(reason, 'send', fact, {
          agentName: 'Codex'
        })
      )
      if (onSendError(message, { announceOnly: true }) === false) {
        deferMobileNativeChatRecoveryNotice(scope, sessionId, message)
        notifyMobileNativeChatInFlightChange()
      }
    }
  )
}

export function confirmMobileRecordedRecovery({
  confirm,
  clientMessageId,
  inFlightIds,
  handBack,
  checked,
  forgetLocalEcho,
  readDelivery,
  sessionId,
  onSendError
}: {
  confirm: MobileStructuredSendConfirmation | null
  clientMessageId: string
  inFlightIds: () => string[]
  handBack: (savedIds: readonly string[]) => void
  checked: Map<string, boolean>
  forgetLocalEcho: (id: string) => void
  readDelivery: () => {
    submissions: readonly AgentSessionDeliveryFact[]
    queuedMessageIds: readonly string[]
  } | null
  sessionId: string | null
  onSendError: MobileNativeChatSendErrorReporter
}): void {
  if (checked.get(clientMessageId) || (!confirm && checked.has(clientMessageId))) {
    return
  }
  checked.set(clientMessageId, Boolean(confirm))
  const stillClaimed = mobileNativeChatInFlightClaim(inFlightIds())
  const settle = (onHost?: MobileStructuredSendRecord) => {
    const ids = stillClaimed()
    if (!ids.length) {
      return
    }
    if (onHost?.recorded) {
      const facts =
        onHost.submission?.clientMessageId === clientMessageId
          ? [onHost.submission]
          : (readDelivery()?.submissions ?? [])
      const queuedMessageIds = onHost.ownedByQueue ? [clientMessageId] : []
      settleMobileInstructionRecovery(sessionId, facts, onSendError, queuedMessageIds, ids)
      markMobileNativeChatInFlightUnconfirmed(ids)
      forgetLocalEcho(clientMessageId)
    } else {
      const confirmedAbsent = onHost?.confirmedAbsent
      const current = confirmedAbsent && readDelivery()
      if (
        current &&
        !ids.some((id) => readMobileNativeChatInFlightSend(id)?.recorded) &&
        !current.submissions.some((entry) => entry.clientMessageId === clientMessageId) &&
        !current.queuedMessageIds.some((id) => id === clientMessageId || ids.includes(id))
      ) {
        handBack(ids)
      } else {
        markMobileNativeChatInFlightUnconfirmed(
          ids,
          confirmedAbsent
            ? undefined
            : () => {
                forgetLocalEcho(clientMessageId)
                return onSendError(UNCONFIRMED_SEND_MESSAGE)
              }
        )
      }
    }
    releaseMobileNativeChatInFlightSends(ids)
  }
  if (confirm) {
    void confirm(clientMessageId).then(settle, () => settle())
  } else {
    settle()
  }
}

export function reconcileMobileStructuredSendDelivery(
  sends: readonly StructuredAgentSessionOptimisticMessage[],
  cursor: AgentJournalCursor | null | undefined,
  submissions: readonly AgentJournalSubmission[],
  queuedMessageIds: readonly string[],
  sessionId: string | null,
  onSendError: MobileNativeChatSendErrorReporter,
  holds: UnconfirmedSendDeadlines<string>,
  forget: (ids: ReadonlySet<string>) => void
): void {
  const settled = settleMobileInstructionRecovery(
    sessionId,
    submissions,
    onSendError,
    queuedMessageIds
  )
  settled?.forEach(holds.cancel)
  if (!sends.length) {
    return
  }
  const recorded = submissions.filter(
    (entry) => entry.reason !== STRUCTURED_AGENT_SESSION_SUBMISSION_MISSING
  )
  const observed = new Set([
    ...(settled ?? []),
    ...queuedMessageIds,
    ...handedOffQueuedMessageIds(recorded),
    ...recorded.map(({ clientMessageId }) => clientMessageId)
  ])
  const echoes = new Set<string>()
  for (const send of sends) {
    const id = send.clientMessageId
    if (observed.has(id) || structuredAgentSessionReadCoversSend(cursor, send.recordedCursor)) {
      echoes.add(id)
    }
  }
  if (echoes.size) {
    forget(echoes)
  }
}
