import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  countUserTextOccurrences,
  findLandedUnconfirmedSends,
  reconcilePendingMessages,
  type UnconfirmedSend
} from './mobile-native-chat-draft-reconcile'
import {
  NO_PENDING_MESSAGES,
  UNCONFIRMED_SEND_DEADLINE_MS,
  type MobileNativeChatPendingMessage,
  type MobileNativeChatSendOrigin
} from './mobile-native-chat-draft-contract'
import { isDraftRev, useMobileNativeChatDraftMutations } from './mobile-native-chat-draft-state'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'

export type { MobileNativeChatPendingMessage } from './mobile-native-chat-draft-contract'

export function useMobileNativeChatDrafts(args: {
  hostId: string
  worktreeId: string
  tabId: string | null
  sessionId: string | null
  messages: readonly NativeChatMessage[]
}): {
  composerText: string
  setComposerText: Dispatch<SetStateAction<string>>
  pending: MobileNativeChatPendingMessage[]
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  /** Clear the composer at send time, before the RPC settles. */
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
  /** Put the text back after a definite rejection, unless newer edits exist. */
  restoreRejectedDraft: (origin: MobileNativeChatSendOrigin, text: string) => void
  acceptSend: (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => void
  holdUnconfirmedSend: (
    origin: MobileNativeChatSendOrigin,
    text: string,
    onUnconfirmed: () => void
  ) => void
} {
  const { hostId, worktreeId, tabId, sessionId, messages } = args
  const draftKey = mobileNativeChatScopeKey(hostId, worktreeId, tabId)
  const pendingKey = draftKey && sessionId ? `${draftKey}\0${sessionId}` : null
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const draftsRef = useRef<Record<string, string>>({})
  const [pendingBySession, setPendingBySession] = useState<
    Record<string, MobileNativeChatPendingMessage[]>
  >({})
  const pendingCounterRef = useRef(0)
  const draftEditRevisionsRef = useRef<Record<string, number>>({})
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const activeDraftKeyRef = useRef(draftKey)
  activeDraftKeyRef.current = draftKey
  const activePendingKeyRef = useRef(pendingKey)
  activePendingKeyRef.current = pendingKey
  const mountedRef = useRef(false)

  const updateDrafts = useCallback(
    (update: (previous: Record<string, string>) => Record<string, string>) => {
      const previous = draftsRef.current
      const next = update(previous)
      if (next === previous) {
        return
      }
      draftsRef.current = next
      setDrafts(next)
    },
    []
  )

  const setComposerText: Dispatch<SetStateAction<string>> = useCallback(
    (value) => {
      if (!draftKey) {
        return
      }
      updateDrafts((previous) => {
        const current = previous[draftKey] ?? ''
        const next = typeof value === 'function' ? value(current) : value
        if (next === current) {
          return previous
        }
        draftEditRevisionsRef.current[draftKey] = (draftEditRevisionsRef.current[draftKey] ?? 0) + 1
        return { ...previous, [draftKey]: next }
      })
    },
    [draftKey, updateDrafts]
  )

  const captureSendOrigin = useCallback(
    (text: string) => {
      if (!draftKey) {
        return null
      }
      const normalizedText = text.trim()
      const currentMessages = messagesRef.current
      return {
        draftKey,
        pendingKey,
        normalizedText,
        baselineOccurrences: countUserTextOccurrences(currentMessages, normalizedText),
        baselineTailMessageId: currentMessages[currentMessages.length - 1]?.id ?? null,
        draftEditRevision: draftEditRevisionsRef.current[draftKey] ?? 0
      }
    },
    [draftKey, pendingKey]
  )

  const { clearDraftForSend, restoreRejectedDraft } = useMobileNativeChatDraftMutations(
    updateDrafts,
    draftEditRevisionsRef
  )

  const acceptSend = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => {
      // Why: the first prompt can be sent before the provider reports a session
      // id; wait for an id before keying an optimistic echo.
      if (!origin.pendingKey) {
        return
      }
      const pendingKey = origin.pendingKey
      pendingCounterRef.current += 1
      setPendingBySession((previous) => {
        const current = previous[pendingKey] ?? NO_PENDING_MESSAGES
        const earlierOutstanding = current.filter(
          (pending) =>
            pending.text.trim() === origin.normalizedText &&
            pending.expectedOccurrence > origin.baselineOccurrences
        ).length
        // An empty-text send reconciles by image-echo ordinal: every outstanding
        // send's ridden-along images echo as `[Image: source: …]` turns after
        // this send's baseline tail, ahead of this send's own echo.
        const expectedImageEchoOrdinal =
          current.reduce(
            (sum, pending) =>
              sum + (pending.images?.length ?? (pending.text.trim() === '' ? 1 : 0)),
            0
          ) + Math.max(1, images?.length ?? 0)
        const pending: MobileNativeChatPendingMessage = {
          id: `pending-${pendingCounterRef.current}`,
          text,
          expectedOccurrence:
            origin.normalizedText === ''
              ? expectedImageEchoOrdinal
              : origin.baselineOccurrences + earlierOutstanding + 1,
          baselineTailMessageId: origin.baselineTailMessageId,
          ...(images && images.length > 0 ? { images } : {})
        }
        return { ...previous, [pendingKey]: [...current, pending] }
      })
    },
    []
  )

  // Why: a relay drop mid-send loses only the ack in the common case — the
  // desktop already delivered the message. Hold the send instead of claiming
  // failure (which baits a duplicate): stay quiet when the transcript echo
  // lands, and surface the uncertainty if the deadline passes without one.
  // The composer was already cleared at send time, so this never touches drafts.
  const unconfirmedRef = useRef<UnconfirmedSend[]>([])
  const surfaceUnconfirmedSend = useCallback(
    (entry: UnconfirmedSend) => {
      if (entry.text.length > 0) {
        updateDrafts((previous) =>
          isDraftRev(draftEditRevisionsRef.current, entry) &&
          (previous[entry.draftKey] ?? '') === ''
            ? { ...previous, [entry.draftKey]: entry.text }
            : previous
        )
      }
      entry.onUnconfirmed()
    },
    [updateDrafts]
  )
  const holdUnconfirmedSend = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string, onUnconfirmed: () => void) => {
      if (!mountedRef.current) {
        return
      }
      const isActiveTranscript =
        activeDraftKeyRef.current === origin.draftKey &&
        (origin.pendingKey === null || activePendingKeyRef.current === origin.pendingKey)
      const entry: UnconfirmedSend = {
        draftKey: origin.draftKey,
        pendingKey: origin.pendingKey,
        text,
        normalizedText: origin.normalizedText,
        baselineTailMessageId: origin.baselineTailMessageId,
        draftEditRevision: origin.draftEditRevision,
        deadline: null,
        expired: false,
        surfaced: false,
        onUnconfirmed
      }
      // Hide an ack-lost draft until its echo fails to arrive without overwriting newer edits.
      updateDrafts((previous) =>
        isDraftRev(draftEditRevisionsRef.current, origin) &&
        (previous[origin.draftKey] ?? '').trim() === text.trim()
          ? { ...previous, [origin.draftKey]: '' }
          : previous
      )
      // Why: the transcript event can beat the lost RPC acknowledgement.
      if (
        isActiveTranscript &&
        findLandedUnconfirmedSends(messagesRef.current, [entry]).length > 0
      ) {
        return
      }
      entry.deadline = setTimeout(() => {
        entry.deadline = null
        const isOriginActive =
          activeDraftKeyRef.current === origin.draftKey &&
          (origin.pendingKey === null || activePendingKeyRef.current === origin.pendingKey)
        if (!isOriginActive) {
          entry.expired = true
          return
        }
        entry.expired = true
        entry.surfaced = true
        surfaceUnconfirmedSend(entry)
      }, UNCONFIRMED_SEND_DEADLINE_MS)
      unconfirmedRef.current = [...unconfirmedRef.current, entry]
    },
    [surfaceUnconfirmedSend, updateDrafts]
  )

  useEffect(() => {
    const stale = unconfirmedRef.current.filter(
      (entry) =>
        entry.draftKey === draftKey && entry.pendingKey !== null && entry.pendingKey !== pendingKey
    )
    if (stale.length === 0) {
      return
    }
    const staleSet = new Set(stale)
    for (const entry of stale) {
      if (entry.deadline !== null) {
        clearTimeout(entry.deadline)
      }
    }
    unconfirmedRef.current = unconfirmedRef.current.filter((entry) => !staleSet.has(entry))
  }, [draftKey, pendingKey])

  useEffect(() => {
    if (!draftKey || unconfirmedRef.current.length === 0) {
      return
    }
    const relevant = unconfirmedRef.current.filter(
      (entry) =>
        entry.draftKey === draftKey &&
        (entry.pendingKey === null || entry.pendingKey === pendingKey)
    )
    const landed = findLandedUnconfirmedSends(messages, relevant)
    const landedSet = new Set(landed)
    const expired = relevant.filter(
      (entry) => entry.expired && !entry.surfaced && !landedSet.has(entry)
    )
    if (landed.length === 0 && expired.length === 0) {
      return
    }
    const completed = new Set([...landed, ...expired])
    unconfirmedRef.current = unconfirmedRef.current.filter((entry) => !completed.has(entry))
    for (const entry of landed) {
      if (entry.deadline !== null) {
        clearTimeout(entry.deadline)
      }
      updateDrafts((previous) =>
        isDraftRev(draftEditRevisionsRef.current, entry) &&
        (previous[entry.draftKey] ?? '').trim() === entry.text.trim()
          ? { ...previous, [entry.draftKey]: '' }
          : previous
      )
    }
    for (const entry of expired) {
      entry.surfaced = true
      surfaceUnconfirmedSend(entry)
    }
  }, [messages, draftKey, pendingKey, surfaceUnconfirmedSend, updateDrafts])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const entry of unconfirmedRef.current) {
        if (entry.deadline !== null) {
          clearTimeout(entry.deadline)
        }
      }
      unconfirmedRef.current = []
    }
  }, [])

  const pending = pendingKey
    ? (pendingBySession[pendingKey] ?? NO_PENDING_MESSAGES)
    : NO_PENDING_MESSAGES
  useEffect(() => {
    if (!pendingKey || pending.length === 0) {
      return
    }
    setPendingBySession((previous) => {
      const current = previous[pendingKey] ?? []
      const next = reconcilePendingMessages(messages, current)
      if (next === current) {
        return previous
      }
      if (next.length > 0) {
        return { ...previous, [pendingKey]: next }
      }
      const remaining = { ...previous }
      delete remaining[pendingKey]
      return remaining
    })
  }, [messages, pending, pendingKey])

  return {
    composerText: draftKey ? (drafts[draftKey] ?? '') : '',
    setComposerText,
    pending,
    captureSendOrigin,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend
  }
}
