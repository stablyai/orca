import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { appendReturnedDraftText } from '../../../../../src/shared/returned-draft-text'
import {
  countUserTextOccurrences,
  findLandedImagePreviewEchoes,
  mergeSentImagePreviews,
  migrateImagePreviewMessageIds
} from './mobile-native-chat-draft-reconcile'
import { normalizeNativeChatUserText as normalizeReconcileText } from '../../../../../src/shared/native-chat-image-transcript-markers'
import { useMobileNativeChatUnconfirmedSends } from '../use-mobile-native-chat-unconfirmed-sends'
import { rebaseMobileNativeChatPendingBaselines } from '../../mobile-native-chat-pending-baseline'
import { retireLandedMobileNativeChatPending } from '../mobile-native-chat-pending-retirement'
import {
  appendMobileNativeChatPending,
  combineMobileNativeChatPending,
  mergeWaitingSessionPending,
  removeWaitingSessionPending,
  type MobileNativeChatPendingMessage,
  type MobileNativeChatSendOrigin
} from '../mobile-native-chat-pending-echo'
import { mobileNativeChatScopeKey } from '../mobile-native-chat-scope-key'
import { useMobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
import {
  clearMobileNativeChatDraftForSend,
  editMobileNativeChatDraft,
  readMobileNativeChatDraftEditGeneration,
  setMobileNativeChatDraftText
} from './mobile-native-chat-draft-store'

const NO_PENDING_MESSAGES: MobileNativeChatPendingMessage[] = []
const NO_IMAGE_PREVIEWS: Record<string, string[]> = {}

export function useMobileNativeChatDrafts(args: {
  hostId: string
  worktreeId: string
  tabId: string | null
  sessionId: string | null
  messages: readonly NativeChatMessage[]
  launchDraft?: string | null
  launchDraftCreatedAt?: number | null
  // Off-chat launch-draft effects hold state rather than reading retraction.
  chatActive?: boolean
  // Unsettled or previous-tab history cannot decline/retire the launch seed.
  transcriptLoading?: boolean
  // Only settled own-session history makes an empty list a real send boundary.
  transcriptSettled: boolean
}): {
  // Subscribe where the text is drawn; a subscriber here redraws the session screen per keystroke.
  draftKey: string | null
  setComposerText: Dispatch<SetStateAction<string>>
  appendComposerText: (text: string) => boolean
  getComposerEditGeneration: () => number
  pending: MobileNativeChatPendingMessage[]
  imagePreviewsByMessageId: Record<string, string[]>
  captureSendOrigin: (text: string, sentAt?: number) => MobileNativeChatSendOrigin | null
  // Retain parked TUI text for sizing pre-clear: one Ctrl+U removes only one logical line.
  readSeededLaunchDraft: () => string | null
  readSeededLaunchDraftSeed: () => MobileNativeChatLaunchDraftSeed | null
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
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
    transcriptSettled
  } = args
  const draftKey = mobileNativeChatScopeKey(hostId, worktreeId, tabId)
  const pendingKey = draftKey && sessionId ? `${draftKey}\0${sessionId}` : null
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
  const composerEditGenerationRef = useRef(0)
  const getComposerEditGeneration = useCallback(() => composerEditGenerationRef.current, [])
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const { readSeededLaunchDraft, readSeededLaunchDraftSeed } = useMobileNativeChatLaunchDraftSeed({
    draftKey,
    messages,
    launchDraft,
    launchDraftCreatedAt,
    chatActive,
    transcriptLoading,
    setDraftText: setMobileNativeChatDraftText
  })

  const setComposerText: Dispatch<SetStateAction<string>> = useCallback(
    (value) => {
      if (!draftKey) {
        return
      }
      composerEditGenerationRef.current += 1
      editMobileNativeChatDraft(draftKey, value)
    },
    [draftKey]
  )
  const appendComposerText = useCallback(
    (text: string): boolean => {
      if (!draftKey || text.length === 0) {
        return false
      }
      composerEditGenerationRef.current += 1
      editMobileNativeChatDraft(draftKey, (current) =>
        current.length === 0 ? text : `${current}\n${text}`
      )
      return true
    },
    [draftKey]
  )

  const captureSendOrigin = useCallback(
    (text: string, sentAt = Date.now()) => {
      if (!draftKey) {
        return null
      }
      const normalizedText = normalizeReconcileText(text)
      return {
        draftKey,
        draftEditGeneration: readMobileNativeChatDraftEditGeneration(draftKey),
        pendingKey,
        normalizedText,
        baselineOccurrences: countUserTextOccurrences(messagesRef.current, normalizedText),
        baselineTailMessageId: messagesRef.current.at(-1)?.id ?? null,
        // Only settled history grants a boundary; failed/hydrating empty lists would let old rows claim new sends.
        baselineResolved: transcriptSettled,
        sentAt
      }
    },
    [draftKey, pendingKey, transcriptSettled]
  )

  // Clear at send time because slow/lost acknowledgements must not leave delivered text in the composer; restore only on rejection.
  const clearDraftForSend = useCallback((origin: MobileNativeChatSendOrigin, text: string) => {
    clearMobileNativeChatDraftForSend(origin.draftKey, origin.draftEditGeneration, text)
  }, [])

  const restoreRejectedDraft = useCallback((origin: MobileNativeChatSendOrigin, text: string) => {
    setMobileNativeChatDraftText(origin.draftKey, (current) =>
      appendReturnedDraftText(current, text)
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

  const { holdUnconfirmedSend } = useMobileNativeChatUnconfirmedSends({
    draftKey,
    pendingKey,
    messages
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
    // Reconcile only own-session reads; pre-read image echoes still risk claiming older identical photos because they cannot safely acquire a new tail.
    const landedImagePreviews = findLandedImagePreviewEchoes(
      messages,
      pending.filter((item) => item.baselineResolved)
    )
    const landedImagePendingIds = new Set(landedImagePreviews.map((preview) => preview.pendingId))
    if (landedImagePreviews.length > 0) {
      setImagePreviewsBySession((previous) =>
        mergeSentImagePreviews(previous, pendingKey, landedImagePreviews)
      )
    }
    setPendingBySession((previous) => {
      const current = previous[pendingKey] ?? []
      // Rebase unresolved sends before retirement so row matching uses their real boundaries.
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
    draftKey,
    setComposerText,
    appendComposerText,
    getComposerEditGeneration,
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
