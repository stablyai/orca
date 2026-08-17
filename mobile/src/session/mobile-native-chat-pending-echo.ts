export type MobileNativeChatPendingMessage = {
  id: string
  text: string
  expectedOccurrence: number
  /** Local preview URIs carried by the send for its optimistic echo. */
  images?: string[]
  baselineTailMessageId: string | null
  /** Whether the transcript this baseline was captured from was already this
   *  session's own history. A send issued mid-hydration is captured unresolved
   *  and rebased onto the first authoritative read instead of reconciling
   *  against rows that may belong to another tab. */
  baselineResolved: boolean
}

export type MobileNativeChatSendOrigin = {
  draftKey: string
  pendingKey: string | null
  normalizedText: string
  baselineOccurrences: number
  baselineTailMessageId: string | null
  baselineResolved: boolean
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
  images?: string[]
): PendingByKey {
  const current = previous[key] ?? []
  const earlierOutstanding = current.filter(
    (pending) =>
      pending.text.trim() === origin.normalizedText &&
      pending.expectedOccurrence > origin.baselineOccurrences
  ).length
  const expectedImageEchoOrdinal =
    current.filter((pending) => pending.text.trim() === '' && pending.images?.length).length + 1
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
        ...(images?.length ? { images } : {})
      }
    ]
  }
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
