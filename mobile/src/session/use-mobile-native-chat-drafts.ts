import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  countImageSourceTurnsAfter,
  countUserTextOccurrences,
  findLandedUnconfirmedSends,
  normalizedUserText,
  type UnconfirmedSend
} from './mobile-native-chat-draft-reconcile'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'

export type MobileNativeChatPendingMessage = {
  id: string
  text: string
  expectedOccurrence: number
  /** Local preview URIs of images ridden along on the send, rendered as thumbnails
   *  on the echo bubble so the sent photo shows before the transcript catches up. */
  images?: string[]
  /** Transcript tail when sent — an image-only echo (no text to match) reconciles
   *  against new `[Image: source: …]` echo turns after this id, so pagination,
   *  agent replies, and unrelated text echoes can't clear it early. */
  baselineTailMessageId: string | null
}
export type MobileNativeChatSendOrigin = {
  draftKey: string
  pendingKey: string | null
  normalizedText: string
  baselineOccurrences: number
  baselineTailMessageId: string | null
}

const NO_PENDING_MESSAGES: MobileNativeChatPendingMessage[] = []

// How long an ack-lost send waits for its transcript echo before the UI surfaces
// that delivery remains unconfirmed.
const UNCONFIRMED_SEND_DEADLINE_MS = 20_000

export function useMobileNativeChatDrafts(args: {
  hostId: string
  worktreeId: string
  tabId: string | null
  sessionId: string | null
  messages: readonly NativeChatMessage[]
  /** Host-provided launch context still parked as an unsent TUI-input draft. */
  launchDraft?: string | null
  /** Whether the tab is currently resolved to the chat view. Off-chat the
   *  launch-draft effects hold their state instead of acting on it. */
  chatActive?: boolean
  /** `messages` is not yet this session's real history (read in flight, or the
   *  transcript still belongs to the previously active tab), so it cannot be
   *  trusted to decline or retire the seed. */
  transcriptLoading?: boolean
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
  const {
    hostId,
    worktreeId,
    tabId,
    sessionId,
    messages,
    launchDraft,
    chatActive = true,
    transcriptLoading
  } = args
  const draftKey = mobileNativeChatScopeKey(hostId, worktreeId, tabId)
  const pendingKey = draftKey && sessionId ? `${draftKey}\0${sessionId}` : null
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pendingBySession, setPendingBySession] = useState<
    Record<string, MobileNativeChatPendingMessage[]>
  >({})
  const pendingCounterRef = useRef(0)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const activeDraftKeyRef = useRef(draftKey)
  activeDraftKeyRef.current = draftKey
  const activePendingKeyRef = useRef(pendingKey)
  activePendingKeyRef.current = pendingKey
  const mountedRef = useRef(false)

  // Seeded launch-context text per tab; '' marks a permanent decline so a
  // cleared composer never resurrects the prefill.
  const seededLaunchDraftByKeyRef = useRef(new Map<string, string>())

  // Why: launch context delivered as a TUI-input prefill is invisible in chat;
  // adopt it once as the composer draft so mobile shows the same context.
  useEffect(() => {
    if (
      !draftKey ||
      !chatActive ||
      !launchDraft?.trim() ||
      seededLaunchDraftByKeyRef.current.has(draftKey)
    ) {
      return
    }
    // Why: `session.tabs` carries launchDraft before the transcript read settles,
    // and an empty (or previous tab's) list would let the decline below misjudge
    // an already-submitted prefill — long enough for a send to duplicate it.
    if (transcriptLoading) {
      return
    }
    // A user turn already in the transcript means the one-line TUI prefill was
    // submitted or deliberately cleared; decline instead of resurrecting it.
    if (messages.some((message) => normalizedUserText(message) !== null)) {
      seededLaunchDraftByKeyRef.current.set(draftKey, '')
      return
    }
    seededLaunchDraftByKeyRef.current.set(draftKey, launchDraft)
    setDrafts((previous) =>
      (previous[draftKey] ?? '') === '' ? { ...previous, [draftKey]: launchDraft } : previous
    )
  }, [chatActive, draftKey, launchDraft, messages, transcriptLoading])

  // Drop an untouched adopted copy once the prefill is resolved elsewhere — a
  // user turn landed (sent or cleared TUI-side) or the host stopped publishing
  // it (desktop sent or reconciled it). User edits are always kept.
  useEffect(() => {
    // Same gates as the seed: off-chat there is no retraction to read (the tab
    // publishes no draft to us), and an untrusted transcript would wipe an
    // untouched copy on the strength of another tab's user turns.
    if (!draftKey || !chatActive || transcriptLoading) {
      return
    }
    const seeded = seededLaunchDraftByKeyRef.current.get(draftKey)
    if (!seeded) {
      return
    }
    const hasUserTurn = messages.some((message) => normalizedUserText(message) !== null)
    if (!hasUserTurn && launchDraft?.trim()) {
      return
    }
    seededLaunchDraftByKeyRef.current.set(draftKey, '')
    setDrafts((previous) =>
      (previous[draftKey] ?? '') === seeded ? { ...previous, [draftKey]: '' } : previous
    )
  }, [chatActive, draftKey, launchDraft, messages, transcriptLoading])

  const setComposerText: Dispatch<SetStateAction<string>> = useCallback(
    (value) => {
      if (!draftKey) {
        return
      }
      setDrafts((previous) => {
        const current = previous[draftKey] ?? ''
        const next = typeof value === 'function' ? value(current) : value
        return next === current ? previous : { ...previous, [draftKey]: next }
      })
    },
    [draftKey]
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
        baselineTailMessageId: currentMessages[currentMessages.length - 1]?.id ?? null
      }
    },
    [draftKey, pendingKey]
  )

  // Why: over relay the send RPC can take seconds (or lose only its ack), and a
  // composer that waits for settlement to empty reads as "my prompt didn't
  // send". Clear at send time; a definite rejection restores the text below.
  const clearDraftForSend = useCallback((origin: MobileNativeChatSendOrigin, text: string) => {
    setDrafts((previous) =>
      (previous[origin.draftKey] ?? '').trim() === text.trim()
        ? { ...previous, [origin.draftKey]: '' }
        : previous
    )
  }, [])

  const restoreRejectedDraft = useCallback((origin: MobileNativeChatSendOrigin, text: string) => {
    // Why: never clobber text the user typed while the rejection was in flight.
    setDrafts((previous) =>
      (previous[origin.draftKey] ?? '') === '' ? { ...previous, [origin.draftKey]: text } : previous
    )
  }, [])

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
          ) + 1
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
        deadline: null
      }
      // Why: the transcript event can beat the lost RPC acknowledgement.
      if (
        isActiveTranscript &&
        findLandedUnconfirmedSends(messagesRef.current, [entry]).length > 0
      ) {
        return
      }
      entry.deadline = setTimeout(() => {
        unconfirmedRef.current = unconfirmedRef.current.filter((held) => held !== entry)
        onUnconfirmed()
      }, UNCONFIRMED_SEND_DEADLINE_MS)
      unconfirmedRef.current = [...unconfirmedRef.current, entry]
    },
    []
  )

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
    if (landed.length === 0) {
      return
    }
    const landedSet = new Set(landed)
    unconfirmedRef.current = unconfirmedRef.current.filter((entry) => !landedSet.has(entry))
    for (const entry of landed) {
      if (entry.deadline !== null) {
        clearTimeout(entry.deadline)
      }
    }
  }, [messages, draftKey, pendingKey])

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
      const landedCounts = new Map<string, number>()
      for (const message of messages) {
        const text = normalizedUserText(message)
        if (text) {
          landedCounts.set(text, (landedCounts.get(text) ?? 0) + 1)
        }
      }
      // Why: compare against the count captured before send; historical equal
      // turns cannot clear a new echo, while duplicates land one occurrence each.
      // An image-only echo has no text to match, so it reconciles by ORDINAL
      // against the count of new `[Image: source: …]` echo turns after its
      // baseline tail — text echoes are excluded so an unrelated outstanding
      // text send cannot clear it. Ordinal-vs-count stays stable when the effect
      // re-runs on the shrunken list, and ignores paginated-in history.
      const next = current.filter((item) =>
        item.text.trim() === ''
          ? countImageSourceTurnsAfter(messages, item.baselineTailMessageId) <
            item.expectedOccurrence
          : (landedCounts.get(item.text.trim()) ?? 0) < item.expectedOccurrence
      )
      if (next.length === current.length) {
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
