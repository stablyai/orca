import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  countImageSourceTurnsAfter,
  countUserTextOccurrences,
  findLandedImagePreviewEchoes,
  findLandedUnconfirmedSends,
  mergeLandedImagePreviewEchoes,
  migrateImagePreviewMessageIds,
  normalizeReconcileText,
  normalizedUserText,
  type UnconfirmedSend
} from './mobile-native-chat-draft-reconcile'
import {
  appendMobileNativeChatPending,
  combineMobileNativeChatPending,
  mergeWaitingSessionPending,
  removeWaitingSessionPending,
  type MobileNativeChatPendingMessage,
  type MobileNativeChatSendOrigin
} from './mobile-native-chat-pending-echo'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import { useMobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'

export type { MobileNativeChatPendingMessage, MobileNativeChatSendOrigin }

const NO_PENDING_MESSAGES: MobileNativeChatPendingMessage[] = []
const NO_IMAGE_PREVIEWS: Record<string, string[]> = {}

// Ack-lost sends wait for a transcript echo before surfacing as unconfirmed.
const UNCONFIRMED_SEND_DEADLINE_MS = 20_000

export function useMobileNativeChatDrafts(args: {
  hostId: string
  worktreeId: string
  tabId: string | null
  sessionId: string | null
  messages: readonly NativeChatMessage[]
  /** Host-provided launch context still parked as an unsent TUI-input draft. */
  launchDraft?: string | null
  launchDraftCreatedAt?: number | null
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
  /** Phone-local previews rebound to the transcript message that replaced the
   *  optimistic echo, keyed by authoritative message id. */
  imagePreviewsByMessageId: Record<string, string[]>
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  /** Launch-context text still believed to be parked on the agent's TUI input
   *  line, or null once it has been declined or retired. Send paths size their
   *  pre-clear from it, since one Ctrl+U clears only one logical line. */
  readSeededLaunchDraft: () => string | null
  readSeededLaunchDraftSeed: () => MobileNativeChatLaunchDraftSeed | null
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
    launchDraftCreatedAt,
    chatActive = true,
    transcriptLoading
  } = args
  const draftKey = mobileNativeChatScopeKey(hostId, worktreeId, tabId)
  const pendingKey = draftKey && sessionId ? `${draftKey}\0${sessionId}` : null
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [pendingBySession, setPendingBySession] = useState<
    Record<string, MobileNativeChatPendingMessage[]>
  >({})
  const [pendingWaitingForSession, setPendingWaitingForSession] = useState<
    Record<string, MobileNativeChatPendingMessage[]>
  >({})
  const [imagePreviewsBySession, setImagePreviewsBySession] = useState<
    Record<string, Record<string, string[]>>
  >({})
  const pendingCounterRef = useRef(0)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const activeDraftKeyRef = useRef(draftKey)
  activeDraftKeyRef.current = draftKey
  const activePendingKeyRef = useRef(pendingKey)
  activePendingKeyRef.current = pendingKey
  const mountedRef = useRef(false)

  const { readSeededLaunchDraft, readSeededLaunchDraftSeed } = useMobileNativeChatLaunchDraftSeed({
    draftKey,
    messages,
    launchDraft,
    launchDraftCreatedAt,
    chatActive,
    transcriptLoading,
    setDrafts
  })

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
      const normalizedText = normalizeReconcileText(text)
      return {
        draftKey,
        pendingKey,
        normalizedText,
        baselineOccurrences: countUserTextOccurrences(messagesRef.current, normalizedText),
        baselineTailMessageId: messagesRef.current.at(-1)?.id ?? null
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
      if (!origin.pendingKey && !images?.length) {
        return
      }
      pendingCounterRef.current += 1
      const id = `pending-${pendingCounterRef.current}`
      const key = origin.pendingKey
      if (key) {
        setPendingBySession((previous) =>
          appendMobileNativeChatPending(previous, key, id, origin, text, images)
        )
      } else {
        setPendingWaitingForSession((previous) =>
          appendMobileNativeChatPending(previous, origin.draftKey, id, origin, text, images)
        )
      }
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
      clearTimeout(entry.deadline ?? undefined)
    }
  }, [messages, draftKey, pendingKey])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const entry of unconfirmedRef.current) {
        clearTimeout(entry.deadline ?? undefined)
      }
      unconfirmedRef.current = []
    }
  }, [])

  const waitingForSession = draftKey
    ? (pendingWaitingForSession[draftKey] ?? NO_PENDING_MESSAGES)
    : NO_PENDING_MESSAGES
  useEffect(() => {
    if (!draftKey || !pendingKey || waitingForSession.length === 0) {
      return
    }
    const movedIds = new Set(waitingForSession.map((item) => item.id))
    setPendingBySession((previous) =>
      mergeWaitingSessionPending(previous, pendingKey, waitingForSession)
    )
    setPendingWaitingForSession((previous) =>
      removeWaitingSessionPending(previous, draftKey, movedIds)
    )
  }, [draftKey, pendingKey, waitingForSession])

  const sessionPending = pendingKey
    ? (pendingBySession[pendingKey] ?? NO_PENDING_MESSAGES)
    : NO_PENDING_MESSAGES
  const pending = combineMobileNativeChatPending(sessionPending, waitingForSession)
  useEffect(() => {
    if (!pendingKey) {
      return
    }
    setImagePreviewsBySession((previous) =>
      migrateImagePreviewMessageIds(previous, pendingKey, messages)
    )
    if (pending.length === 0) {
      return
    }
    const landedImagePreviews = findLandedImagePreviewEchoes(messages, pending)
    const landedImagePendingIds = new Set(landedImagePreviews.map((preview) => preview.pendingId))
    if (landedImagePreviews.length > 0) {
      setImagePreviewsBySession((previous) =>
        mergeLandedImagePreviewEchoes(previous, pendingKey, landedImagePreviews)
      )
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
      // Image-only source-turn counts stay stable across reruns and ignore paginated history.
      const next = current.filter((item) => {
        if (landedImagePendingIds.has(item.id)) {
          return false
        }
        // Keep image echoes until their local preview reaches the authoritative message.
        if (item.images?.length) {
          return true
        }
        return item.text.trim() === ''
          ? countImageSourceTurnsAfter(messages, item.baselineTailMessageId) <
              item.expectedOccurrence
          : (landedCounts.get(normalizeReconcileText(item.text)) ?? 0) < item.expectedOccurrence
      })
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
    imagePreviewsByMessageId: pendingKey
      ? (imagePreviewsBySession[pendingKey] ?? NO_IMAGE_PREVIEWS)
      : NO_IMAGE_PREVIEWS,
    captureSendOrigin,
    readSeededLaunchDraft,
    readSeededLaunchDraftSeed,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend
  }
}
