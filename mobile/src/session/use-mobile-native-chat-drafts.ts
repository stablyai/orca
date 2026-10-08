import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { appendReturnedDraftText } from '../../../src/shared/returned-draft-text'
import {
  countUserTextOccurrences,
  findLandedImagePreviewEchoes,
  mergeLandedImagePreviewEchoes,
  migrateImagePreviewMessageIds,
  normalizeReconcileText
} from './mobile-native-chat-draft-reconcile'
import { useMobileNativeChatUnconfirmedSends } from './use-mobile-native-chat-unconfirmed-sends'
import { rebaseMobileNativeChatPendingBaselines } from './mobile-native-chat-pending-baseline'
import { retireLandedMobileNativeChatPending } from './mobile-native-chat-pending-retirement'
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
import { MobileNativeChatDraftEditGenerations } from './mobile-native-chat-draft-edit-generations'

export type { MobileNativeChatPendingMessage, MobileNativeChatSendOrigin }

const NO_PENDING_MESSAGES: MobileNativeChatPendingMessage[] = []
const NO_IMAGE_PREVIEWS: Record<string, string[]> = {}

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
  /** `messages` is this session's own settled history — so an empty one really
   *  is an empty conversation, not a read that failed or never ran. Only then
   *  does a send's captured tail describe a real boundary. */
  transcriptSettled: boolean
  /** The active pane's host-held queued-draft cards (structured lane only). */
  queuedCards?: readonly { messageId: string; text: string }[]
}): {
  composerText: string
  setComposerText: Dispatch<SetStateAction<string>>
  /** Append after existing typing (newline-joined); a queued card's Edit copy lands here.
   *  False when nothing was appended: no active draft, or no text. */
  appendComposerText: (text: string) => boolean
  getComposerEditGeneration: () => number
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
  /** Put the text back after a definite rejection, after whatever the composer holds now. */
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
    transcriptLoading,
    transcriptSettled,
    queuedCards
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
  const draftEditGenerationsRef = useRef(new MobileNativeChatDraftEditGenerations())
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const queuedCardsRef = useRef(queuedCards)
  // Read only by captureSendOrigin, which runs from a send after this commit.
  useLayoutEffect(() => {
    queuedCardsRef.current = queuedCards
  }, [queuedCards])

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
      draftEditGenerationsRef.current.advance(draftKey)
      setDrafts((previous) => {
        const current = previous[draftKey] ?? ''
        const next = typeof value === 'function' ? value(current) : value
        return next === current ? previous : { ...previous, [draftKey]: next }
      })
    },
    [draftKey]
  )
  // Copied queued-card text goes after whatever is there, so newer typing is preserved.
  const appendComposerText = useCallback(
    (text: string): boolean => {
      if (!draftKey || text.length === 0) {
        return false
      }
      draftEditGenerationsRef.current.advance(draftKey)
      setDrafts((previous) => {
        const current = previous[draftKey] ?? ''
        const next = current.length === 0 ? text : `${current}\n${text}`
        return { ...previous, [draftKey]: next }
      })
      return true
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
        draftEditGeneration: draftEditGenerationsRef.current.readDraft(draftKey),
        pendingKey,
        normalizedText,
        baselineOccurrences: countUserTextOccurrences(messagesRef.current, normalizedText),
        baselineTailMessageId: messagesRef.current.at(-1)?.id ?? null,
        // Only a settled read makes this a boundary. Anything else — hydrating,
        // or a read that failed — hands back an empty list that reads as "the
        // conversation was empty", which lets any row claim this send later.
        baselineResolved: transcriptSettled,
        ...(queuedCardsRef.current?.length
          ? { baselineQueuedMessageIds: queuedCardsRef.current.map((card) => card.messageId) }
          : {})
      }
    },
    [draftKey, pendingKey, transcriptSettled]
  )

  // Why: over relay the send RPC can take seconds (or lose only its ack), and a
  // composer that waits for settlement to empty reads as "my prompt didn't
  // send". Clear at send time; a definite rejection restores the text below.
  const clearDraftForSend = useCallback((origin: MobileNativeChatSendOrigin, text: string) => {
    setDrafts((previous) =>
      draftEditGenerationsRef.current.isCurrent(origin.draftKey, origin.draftEditGeneration) &&
      (previous[origin.draftKey] ?? '') === text
        ? { ...previous, [origin.draftKey]: '' }
        : previous
    )
  }, [])

  const restoreRejectedDraft = useCallback((origin: MobileNativeChatSendOrigin, text: string) => {
    // Appended, so typing done while the send was in flight stays and the returned text isn't dropped.
    setDrafts((previous) => {
      const current = previous[origin.draftKey] ?? ''
      const next = appendReturnedDraftText(current, text)
      return next === current ? previous : { ...previous, [origin.draftKey]: next }
    })
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

  const { holdUnconfirmedSend } = useMobileNativeChatUnconfirmedSends({
    draftKey,
    pendingKey,
    messages,
    ...(queuedCards ? { queuedCards } : {})
  })

  const waitingForSession = draftKey
    ? (pendingWaitingForSession[draftKey] ?? NO_PENDING_MESSAGES)
    : NO_PENDING_MESSAGES
  useEffect(() => {
    if (!draftKey || !pendingKey || waitingForSession.length === 0) {
      return
    }
    const movedIds = new Set(waitingForSession.map((item) => item.id))
    setPendingBySession((state) => mergeWaitingSessionPending(state, pendingKey, waitingForSession))
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
    // Only judge a send against a read known to be this session's. Note this
    // does NOT give an image echo a boundary — the rebase deliberately leaves
    // those on whatever they captured — so a caption-less photo sent before any
    // read settled can still claim an older photo turn, exactly as it does on
    // main. Fixing that needs a tail that excludes older image turns without
    // excluding the send's own echo, which is a separate change.
    const landedImagePreviews = findLandedImagePreviewEchoes(
      messages,
      pending.filter((item) => item.baselineResolved)
    )
    const landedImagePendingIds = new Set(landedImagePreviews.map((preview) => preview.pendingId))
    if (landedImagePreviews.length > 0) {
      setImagePreviewsBySession((previous) =>
        mergeLandedImagePreviewEchoes(previous, pendingKey, landedImagePreviews)
      )
    }
    setPendingBySession((previous) => {
      const current = previous[pendingKey] ?? []
      // Rebase before retiring: a send captured before the history was known has
      // to own a real boundary before any row can be judged against it.
      const rebased = transcriptSettled
        ? rebaseMobileNativeChatPendingBaselines(messages, current)
        : current
      const next = retireLandedMobileNativeChatPending(messages, rebased, landedImagePendingIds)
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
  }, [messages, pending, pendingKey, transcriptSettled])

  return {
    composerText: draftKey ? (drafts[draftKey] ?? '') : '',
    setComposerText,
    appendComposerText,
    getComposerEditGeneration: draftEditGenerationsRef.current.readComposer,
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
