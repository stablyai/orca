import { nativeChatAsyncAnswerEchoHolding } from '../../../src/shared/native-chat-async-answer-progress'
import { isNoiseMessage } from '../../../src/shared/native-chat-noise'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { normalizeReconcileText, normalizedUserText } from './mobile-native-chat-draft-reconcile'

export type MobileNativeChatPendingMessage = {
  id: string
  text: string
  expectedOccurrence: number
  /** Local preview URIs carried by the send for its optimistic echo. */
  images?: string[]
  /** An async question card's answers, by question key: the card holds them while this waits. */
  asyncAnswers?: Readonly<Record<string, string>>
  /** With `asyncAnswers`: normalized texts of the echoes still waiting when it was sent, whose
   *  rows may land after it without saying anything about it. */
  queuedAhead?: readonly string[]
  baselineTailMessageId: string | null
  /** Whether the transcript this baseline was captured from was already this
   *  session's own history. A send issued mid-hydration is captured unresolved
   *  and rebased onto the first authoritative read instead of reconciling
   *  against rows that may belong to another tab. */
  baselineResolved: boolean
}

export type MobileNativeChatSendOrigin = {
  draftKey: string
  draftEditGeneration: number
  pendingKey: string | null
  normalizedText: string
  baselineOccurrences: number
  baselineTailMessageId: string | null
  baselineResolved: boolean
  /** Queued-draft cards already on screen at send time, so an earlier identical
   *  card cannot confirm this send. Structured lane on a queue-capable host only. */
  baselineQueuedMessageIds?: readonly string[]
}

type PendingByKey = Record<string, MobileNativeChatPendingMessage[]>

export function combineMobileNativeChatPending(
  session: MobileNativeChatPendingMessage[],
  waiting: readonly MobileNativeChatPendingMessage[]
): MobileNativeChatPendingMessage[] {
  if (waiting.length === 0) {
    return session
  }
  const sessionIds = new Set(session.map((item) => item.id))
  return [...session, ...waiting.filter((item) => !sessionIds.has(item.id))]
}

export function appendMobileNativeChatPending(
  previous: PendingByKey,
  key: string,
  id: string,
  origin: MobileNativeChatSendOrigin,
  text: string,
  images?: string[],
  asyncAnswers?: Readonly<Record<string, string>>
): PendingByKey {
  const current = previous[key] ?? []
  // Count outstanding repeats with the same normalized key.
  const earlierOutstanding = current.filter(
    (pending) =>
      normalizeReconcileText(pending.text) === origin.normalizedText &&
      pending.expectedOccurrence > origin.baselineOccurrences
  ).length
  // Image ordinal selection and counting must share the empty-text discriminator.
  const expectedImageEchoOrdinal =
    current.filter(
      (pending) => normalizeReconcileText(pending.text) === '' && pending.images?.length
    ).length + 1
  return {
    ...previous,
    [key]: [
      ...current,
      {
        id,
        text,
        expectedOccurrence:
          origin.normalizedText === ''
            ? expectedImageEchoOrdinal
            : origin.baselineOccurrences + earlierOutstanding + 1,
        baselineTailMessageId: origin.baselineTailMessageId,
        baselineResolved: origin.baselineResolved,
        ...(images?.length ? { images } : {}),
        ...(asyncAnswers
          ? {
              asyncAnswers,
              queuedAhead: current.map((pending) => normalizeReconcileText(pending.text))
            }
          : {})
      }
    ]
  }
}

/** Whether an answer echo still holds its answers: until its row lands, or until the agent
 *  records a user row that neither it nor an echo queued ahead of it accounts for. Without a
 *  known baseline in `messages` nothing can be read, so it keeps holding. */
export function mobileNativeChatAnswerEchoHolding(
  echo: MobileNativeChatPendingMessage,
  messages: readonly NativeChatMessage[]
): boolean {
  const tail =
    echo.baselineTailMessageId === null
      ? -1
      : messages.findIndex((message) => message.id === echo.baselineTailMessageId)
  if (!echo.baselineResolved || (echo.baselineTailMessageId !== null && tail === -1)) {
    return true
  }
  const rows = messages.slice(tail + 1).flatMap((message) => {
    const text = isNoiseMessage(message) ? null : normalizedUserText(message)
    return text ? [text] : []
  })
  return nativeChatAsyncAnswerEchoHolding(
    { text: normalizeReconcileText(echo.text), queuedAhead: echo.queuedAhead },
    rows
  )
}

export function mergeWaitingSessionPending(
  previous: PendingByKey,
  sessionKey: string,
  waiting: readonly MobileNativeChatPendingMessage[]
): PendingByKey {
  const current = previous[sessionKey] ?? []
  const currentIds = new Set(current.map((item) => item.id))
  const moved = waiting.filter((item) => !currentIds.has(item.id))
  return moved.length > 0 ? { ...previous, [sessionKey]: [...current, ...moved] } : previous
}

export function removeWaitingSessionPending(
  previous: PendingByKey,
  draftKey: string,
  movedIds: ReadonlySet<string>
): PendingByKey {
  const remaining = (previous[draftKey] ?? []).filter((item) => !movedIds.has(item.id))
  if (remaining.length > 0) {
    return { ...previous, [draftKey]: remaining }
  }
  if (!(draftKey in previous)) {
    return previous
  }
  const next = { ...previous }
  delete next[draftKey]
  return next
}
