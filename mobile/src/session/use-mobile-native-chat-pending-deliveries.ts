import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MOBILE_WEB_NATIVE_CHAT_PENDING_DELIVERY_LIMIT } from '../../../src/shared/mobile-web/native-chat-operation-contract'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { HostSessionChatPendingDeliveryOperations } from './host-session-chat-pending-delivery-operations'
import {
  countUserTextOccurrences,
  findLandedImagePreviewEchoes,
  mergeLandedImagePreviewEchoes,
  migrateImagePreviewMessageIds
} from './mobile-native-chat-draft-reconcile'
import { rebaseMobileNativeChatPendingBaselines } from './mobile-native-chat-pending-baseline'
import { retireLandedMobileNativeChatPending } from './mobile-native-chat-pending-retirement'
import {
  appendMobileNativeChatPending,
  combineMobileNativeChatPending,
  mergeWaitingSessionPending,
  nextMobileNativeChatPendingId,
  omitMobileNativeChatPendingKey,
  removeWaitingSessionPending,
  type MobileNativeChatPendingMessage
} from './mobile-native-chat-pending-echo'

export type { MobileNativeChatPendingMessage } from './mobile-native-chat-pending-echo'

export type MobileNativeChatPendingDeliveryTarget = {
  workspaceId: string
  tabId: string
  sessionId: string
}

export type MobileNativeChatPendingDeliveryOrigin = {
  pendingKey: string | null
  pendingStorageKey: string | null
  normalizedText: string
  baselineOccurrences: number
  baselineTailMessageId: string | null
  baselineResolved: boolean
  pendingTarget: MobileNativeChatPendingDeliveryTarget | null
}

const NO_PENDING_MESSAGES: MobileNativeChatPendingMessage[] = []
const NO_IMAGE_PREVIEWS: Record<string, string[]> = {}

export function useMobileNativeChatPendingDeliveries(args: {
  hostId: string
  worktreeId: string
  tabId: string | null
  sessionId: string | null
  messages: readonly NativeChatMessage[]
  persistence: HostSessionChatPendingDeliveryOperations | null
  transcriptSettled: boolean
}): {
  pendingKey: string | null
  pending: MobileNativeChatPendingMessage[]
  imagePreviewsByMessageId: Record<string, string[]>
  captureOrigin: (normalizedText: string) => MobileNativeChatPendingDeliveryOrigin
  accept: (origin: MobileNativeChatPendingDeliveryOrigin, text: string, images?: string[]) => void
} {
  const { hostId, worktreeId, tabId, sessionId, messages, persistence, transcriptSettled } = args
  const waitingKey = tabId ? `${hostId}\0${worktreeId}\0${tabId}` : null
  const pendingKey = tabId && sessionId ? `${hostId}\0${worktreeId}\0${tabId}\0${sessionId}` : null
  const pendingTarget = useMemo(
    () => (tabId && sessionId ? { workspaceId: worktreeId, tabId, sessionId } : null),
    [sessionId, tabId, worktreeId]
  )
  const [pendingBySession, setPendingBySession] = useState<
    Record<string, MobileNativeChatPendingMessage[]>
  >({})
  const [imagePreviewsBySession, setImagePreviewsBySession] = useState<
    Record<string, Record<string, string[]>>
  >({})
  const pendingBySessionRef = useRef(pendingBySession)
  useEffect(() => {
    pendingBySessionRef.current = pendingBySession
  }, [pendingBySession])
  const editVersionRef = useRef<Record<string, number>>({})
  const hydratedKeysRef = useRef(new Set<string>())
  const nextMessageIdRef = useRef(0)
  const saveQueueRef = useRef(new Map<string, Promise<void>>())

  const queueSave = useCallback(
    (
      key: string,
      target: MobileNativeChatPendingDeliveryTarget,
      deliveries: readonly MobileNativeChatPendingMessage[]
    ) => {
      if (!persistence) {
        return
      }
      const prior = saveQueueRef.current.get(key) ?? Promise.resolve()
      const next = prior
        .catch(() => {})
        .then(() =>
          persistence.save(
            target.workspaceId,
            target.tabId,
            target.sessionId,
            deliveries
              .filter(({ text }) => text.trim().length > 0)
              .map(({ text, expectedOccurrence }) => ({ text, expectedOccurrence }))
          )
        )
      saveQueueRef.current.set(key, next)
      void next.then(
        () => {
          if (saveQueueRef.current.get(key) === next) {
            saveQueueRef.current.delete(key)
          }
        },
        () => {
          if (saveQueueRef.current.get(key) === next) {
            saveQueueRef.current.delete(key)
          }
        }
      )
    },
    [persistence]
  )

  const replacePending = useCallback(
    (
      key: string,
      target: MobileNativeChatPendingDeliveryTarget | null,
      deliveries: MobileNativeChatPendingMessage[]
    ) => {
      editVersionRef.current[key] = (editVersionRef.current[key] ?? 0) + 1
      const nextState =
        deliveries.length > 0
          ? { ...pendingBySessionRef.current, [key]: deliveries }
          : omitMobileNativeChatPendingKey(pendingBySessionRef.current, key)
      pendingBySessionRef.current = nextState
      setPendingBySession(nextState)
      if (target) {
        queueSave(key, target, deliveries)
      }
    },
    [queueSave]
  )

  useEffect(() => {
    if (!pendingKey || !pendingTarget || !persistence || hydratedKeysRef.current.has(pendingKey)) {
      return
    }
    let active = true
    const editVersion = editVersionRef.current[pendingKey] ?? 0
    void persistence
      .load(pendingTarget.workspaceId, pendingTarget.tabId, pendingTarget.sessionId)
      .then((stored) => {
        hydratedKeysRef.current.add(pendingKey)
        if (!active || (editVersionRef.current[pendingKey] ?? 0) !== editVersion) {
          return
        }
        const deliveries = stored.map((delivery) => ({
          id: nextMobileNativeChatPendingId(nextMessageIdRef),
          ...delivery,
          baselineTailMessageId: null,
          baselineResolved: false
        }))
        const nextState =
          deliveries.length > 0
            ? { ...pendingBySessionRef.current, [pendingKey]: deliveries }
            : pendingBySessionRef.current
        pendingBySessionRef.current = nextState
        setPendingBySession(nextState)
      })
      .catch(() => {
        hydratedKeysRef.current.add(pendingKey)
      })
    return () => {
      active = false
    }
  }, [pendingKey, pendingTarget, persistence])

  const captureOrigin = useCallback(
    (normalizedText: string): MobileNativeChatPendingDeliveryOrigin => ({
      pendingKey,
      pendingStorageKey: pendingKey ?? waitingKey,
      normalizedText,
      baselineOccurrences: countUserTextOccurrences(messages, normalizedText),
      baselineTailMessageId: messages.at(-1)?.id ?? null,
      baselineResolved: transcriptSettled,
      pendingTarget
    }),
    [messages, pendingKey, pendingTarget, transcriptSettled, waitingKey]
  )

  const accept = useCallback(
    (origin: MobileNativeChatPendingDeliveryOrigin, text: string, images?: string[]) => {
      const storageKey = origin.pendingStorageKey
      if (!storageKey || (!origin.pendingTarget && !images?.length)) {
        return
      }
      const current = pendingBySessionRef.current[storageKey] ?? NO_PENDING_MESSAGES
      const next = appendMobileNativeChatPending(
        current,
        nextMobileNativeChatPendingId(nextMessageIdRef),
        origin,
        text,
        images
      ).slice(-MOBILE_WEB_NATIVE_CHAT_PENDING_DELIVERY_LIMIT)
      replacePending(storageKey, origin.pendingTarget, next)
    },
    [replacePending]
  )

  const sessionPending = pendingKey
    ? (pendingBySession[pendingKey] ?? NO_PENDING_MESSAGES)
    : NO_PENDING_MESSAGES
  const waitingForSession = waitingKey
    ? (pendingBySession[waitingKey] ?? NO_PENDING_MESSAGES)
    : NO_PENDING_MESSAGES
  const pending = combineMobileNativeChatPending(sessionPending, waitingForSession)
  useEffect(() => {
    if (!pendingKey || !pendingTarget || !waitingKey || waitingForSession.length === 0) {
      return
    }
    const movedIds = new Set(waitingForSession.map((item) => item.id))
    const merged = mergeWaitingSessionPending(
      pendingBySessionRef.current,
      pendingKey,
      waitingForSession
    )
    const next = removeWaitingSessionPending(merged, waitingKey, movedIds)
    pendingBySessionRef.current = next
    editVersionRef.current[pendingKey] = (editVersionRef.current[pendingKey] ?? 0) + 1
    setPendingBySession(next)
    queueSave(pendingKey, pendingTarget, next[pendingKey] ?? [])
  }, [pendingKey, pendingTarget, queueSave, waitingForSession, waitingKey])
  useEffect(() => {
    if (!pendingKey || !pendingTarget) {
      return
    }
    setImagePreviewsBySession((previous) =>
      migrateImagePreviewMessageIds(previous, pendingKey, messages)
    )
    if (pending.length === 0) {
      return
    }
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
    const rebased = transcriptSettled
      ? rebaseMobileNativeChatPendingBaselines(messages, pending)
      : pending
    const next = retireLandedMobileNativeChatPending(messages, rebased, landedImagePendingIds)
    if (next !== pending) {
      replacePending(pendingKey, pendingTarget, next)
    }
  }, [messages, pending, pendingKey, pendingTarget, replacePending, transcriptSettled])

  return {
    pendingKey,
    pending,
    imagePreviewsByMessageId: pendingKey
      ? (imagePreviewsBySession[pendingKey] ?? NO_IMAGE_PREVIEWS)
      : NO_IMAGE_PREVIEWS,
    captureOrigin,
    accept
  }
}
