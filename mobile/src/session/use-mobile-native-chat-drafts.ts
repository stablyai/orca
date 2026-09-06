import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { HostSessionChatDraftOperations } from './host-session-chat-draft-operations'
import type { HostSessionChatPendingDeliveryOperations } from './host-session-chat-pending-delivery-operations'
import {
  findLandedUnconfirmedSends,
  normalizeReconcileText,
  type UnconfirmedSend
} from './mobile-native-chat-draft-reconcile'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import { useMobileNativeChatDraftPersistence } from './use-mobile-native-chat-draft-persistence'
import { useMobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
import {
  useMobileNativeChatPendingDeliveries,
  type MobileNativeChatPendingDeliveryOrigin,
  type MobileNativeChatPendingMessage
} from './use-mobile-native-chat-pending-deliveries'
import { MobileNativeChatDraftEditGenerations } from './mobile-native-chat-draft-edit-generations'

export type MobileNativeChatSendOrigin = MobileNativeChatPendingDeliveryOrigin & {
  draftKey: string
  draftEditGeneration: number
}

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
  persistence?: HostSessionChatDraftOperations | null
  pendingPersistence?: HostSessionChatPendingDeliveryOperations | null
  /** `messages` is this session's own settled history — so an empty one really
   *  is an empty conversation, not a read that failed or never ran. Only then
   *  does a send's captured tail describe a real boundary. */
  transcriptSettled: boolean
}): {
  composerText: string
  setComposerText: Dispatch<SetStateAction<string>>
  getComposerEditGeneration: () => number
  pending: MobileNativeChatPendingMessage[]
  /** Phone-local previews rebound to the transcript message that replaced the
   *  optimistic echo, keyed by authoritative message id. */
  imagePreviewsByMessageId: Record<string, string[]>
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
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
    persistence = null,
    pendingPersistence = null,
    transcriptSettled
  } = args
  const draftKey = mobileNativeChatScopeKey(hostId, worktreeId, tabId)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const draftEditGenerationsRef = useRef(new MobileNativeChatDraftEditGenerations())
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const activeDraftKeyRef = useRef(draftKey)
  activeDraftKeyRef.current = draftKey
  const {
    pendingKey,
    pending,
    imagePreviewsByMessageId,
    captureOrigin: capturePendingOrigin,
    accept: acceptPending
  } = useMobileNativeChatPendingDeliveries({
    hostId,
    worktreeId,
    tabId,
    sessionId,
    messages,
    persistence: pendingPersistence,
    transcriptSettled
  })
  const activePendingKeyRef = useRef(pendingKey)
  activePendingKeyRef.current = pendingKey
  const mountedRef = useRef(false)
  const composerText = draftKey ? (drafts[draftKey] ?? '') : ''
  const { markDraftEdited } = useMobileNativeChatDraftPersistence({
    draftKey,
    worktreeId,
    tabId,
    text: composerText,
    drafts,
    setDrafts,
    persistence
  })

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
      markDraftEdited()
      draftEditGenerationsRef.current.advance(draftKey)
      setDrafts((previous) => {
        const current = previous[draftKey] ?? ''
        const next = typeof value === 'function' ? value(current) : value
        return next === current ? previous : { ...previous, [draftKey]: next }
      })
    },
    [draftKey, markDraftEdited]
  )

  const captureSendOrigin = useCallback(
    (text: string) =>
      draftKey
        ? {
            draftKey,
            draftEditGeneration: draftEditGenerationsRef.current.readDraft(draftKey),
            // Transcript rows are compared fully normalized (ANSI stripped, whitespace
            // runs collapsed); a bare trim leaves every multi-line prompt unmatchable.
            ...capturePendingOrigin(normalizeReconcileText(text))
          }
        : null,
    [capturePendingOrigin, draftKey]
  )

  const clearDraftForSend = useCallback((origin: MobileNativeChatSendOrigin, text: string) => {
    setDrafts((previous) =>
      draftEditGenerationsRef.current.isCurrent(origin.draftKey, origin.draftEditGeneration) &&
      (previous[origin.draftKey] ?? '') === text
        ? { ...previous, [origin.draftKey]: '' }
        : previous
    )
  }, [])

  const restoreRejectedDraft = useCallback((origin: MobileNativeChatSendOrigin, text: string) => {
    setDrafts((previous) =>
      draftEditGenerationsRef.current.isCurrent(origin.draftKey, origin.draftEditGeneration) &&
      (previous[origin.draftKey] ?? '') === ''
        ? { ...previous, [origin.draftKey]: text }
        : previous
    )
  }, [])

  const acceptSend = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => {
      acceptPending(origin, text, images)
    },
    [acceptPending]
  )

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

  return {
    composerText,
    setComposerText,
    getComposerEditGeneration: draftEditGenerationsRef.current.readComposer,
    pending,
    imagePreviewsByMessageId,
    captureSendOrigin,
    readSeededLaunchDraft,
    readSeededLaunchDraftSeed,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend
  }
}
