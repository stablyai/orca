import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { AgentPromptSubmissionOccurrence } from '../../../src/shared/agent-status-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  assignMobileNativeChatPromptSubmissions,
  MOBILE_NATIVE_CHAT_DELIVERY_CONFIRMATION_MS,
  mobileNativeChatPromptDigest,
  type MobileNativeChatDeliveryCheck
} from './mobile-native-chat-prompt-delivery'
import type {
  MobileNativeChatPendingMessage,
  MobileNativeChatSendOrigin
} from './mobile-native-chat-pending-echo'
import { appendMobileNativeChatPending } from './mobile-native-chat-pending-echo'
import { findLandedUnconfirmedSends } from './mobile-native-chat-draft-reconcile'

type PendingByKey = Record<string, MobileNativeChatPendingMessage[]>

type DeliveryRecoveryArgs = {
  draftKey: string | null
  pendingKey: string | null
  messages: readonly NativeChatMessage[]
  promptSubmissions: readonly AgentPromptSubmissionOccurrence[]
  setDrafts: Dispatch<SetStateAction<Record<string, string>>>
  setPendingBySession: Dispatch<SetStateAction<PendingByKey>>
  setPendingWaitingForSession: Dispatch<SetStateAction<PendingByKey>>
}

function occurrenceKey(occurrence: AgentPromptSubmissionOccurrence): string {
  return `${occurrence.streamId}\0${occurrence.sequence}`
}

function removePendingCheck(
  previous: PendingByKey,
  check: MobileNativeChatDeliveryCheck
): PendingByKey {
  const key = check.pendingKey ?? check.draftKey
  const current = previous[key] ?? []
  const next = current.filter((entry) => entry.id !== check.pendingId)
  if (next.length === current.length) {
    return previous
  }
  if (next.length > 0) {
    return { ...previous, [key]: next }
  }
  const remaining = { ...previous }
  delete remaining[key]
  return remaining
}

export function useMobileNativeChatDeliveryRecovery({
  draftKey,
  pendingKey,
  messages,
  promptSubmissions,
  setDrafts,
  setPendingBySession,
  setPendingWaitingForSession
}: DeliveryRecoveryArgs): {
  deliveryFailed: boolean
  acceptSend: (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => void
  readPromptSubmissionBaseline: () => AgentPromptSubmissionOccurrence | undefined
} {
  const activeDraftKeyRef = useRef(draftKey)
  const activePendingKeyRef = useRef(pendingKey)
  const messagesRef = useRef(messages)
  const promptSubmissionsRef = useRef(promptSubmissions)
  const pendingCounterRef = useRef(0)
  const deliveryChecksRef = useRef<MobileNativeChatDeliveryCheck[]>([])
  const [failureDraftKey, setFailureDraftKey] = useState<string | null>(null)

  useLayoutEffect(() => {
    activeDraftKeyRef.current = draftKey
    activePendingKeyRef.current = pendingKey
    messagesRef.current = messages
    promptSubmissionsRef.current = promptSubmissions
  }, [draftKey, messages, pendingKey, promptSubmissions])

  const readPromptSubmissionBaseline = useCallback(() => promptSubmissionsRef.current.at(-1), [])

  const trackAcceptedTextSend = useCallback(
    (pendingId: string, origin: MobileNativeChatSendOrigin, text: string) => {
      const check: MobileNativeChatDeliveryCheck = {
        pendingId,
        draftKey: origin.draftKey,
        pendingKey: origin.pendingKey,
        text,
        normalizedText: origin.normalizedText,
        baselineTailMessageId: origin.baselineTailMessageId,
        expectedDigest: mobileNativeChatPromptDigest(text),
        ...(origin.promptSubmissionBaseline ? { baseline: origin.promptSubmissionBaseline } : {}),
        deadline: null
      }
      check.deadline = setTimeout(() => {
        const isActiveTranscript =
          activeDraftKeyRef.current === check.draftKey &&
          (check.pendingKey === null || activePendingKeyRef.current === check.pendingKey)
        const transcriptLanded =
          isActiveTranscript && findLandedUnconfirmedSends(messagesRef.current, [check]).length > 0
        if (transcriptLanded) {
          deliveryChecksRef.current = deliveryChecksRef.current.filter((held) => held !== check)
          return
        }
        const acknowledgedBy = assignMobileNativeChatPromptSubmissions(
          deliveryChecksRef.current,
          promptSubmissionsRef.current
        ).get(check.pendingId)
        if (acknowledgedBy) {
          check.deadline = null
          check.acknowledgedBy = acknowledgedBy
          return
        }
        deliveryChecksRef.current = deliveryChecksRef.current.filter((held) => held !== check)
        if (check.pendingKey) {
          setPendingBySession((previous) => removePendingCheck(previous, check))
        } else {
          setPendingWaitingForSession((previous) => removePendingCheck(previous, check))
        }
        setDrafts((previous) => {
          const current = previous[check.draftKey] ?? ''
          if (current === check.text) {
            return previous
          }
          const restored = current.length === 0 ? check.text : `${check.text}\n\n${current}`
          return { ...previous, [check.draftKey]: restored }
        })
        setFailureDraftKey(check.draftKey)
      }, MOBILE_NATIVE_CHAT_DELIVERY_CONFIRMATION_MS)
      deliveryChecksRef.current = [...deliveryChecksRef.current, check]
    },
    [setDrafts, setPendingBySession, setPendingWaitingForSession]
  )

  const acceptSend = useCallback(
    (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => {
      pendingCounterRef.current += 1
      const id = `pending-${pendingCounterRef.current}`
      setFailureDraftKey(null)
      if (origin.pendingKey) {
        const key = origin.pendingKey
        setPendingBySession((previous) =>
          appendMobileNativeChatPending(previous, key, id, origin, text, images)
        )
      } else if (images?.length) {
        setPendingWaitingForSession((previous) =>
          appendMobileNativeChatPending(previous, origin.draftKey, id, origin, text, images)
        )
      }
      if (!images?.length && text.trim().length > 0) {
        trackAcceptedTextSend(id, origin, text)
      }
    },
    [setPendingBySession, setPendingWaitingForSession, trackAcceptedTextSend]
  )

  useEffect(() => {
    const assignments = assignMobileNativeChatPromptSubmissions(
      deliveryChecksRef.current,
      promptSubmissions
    )
    for (const check of deliveryChecksRef.current) {
      const acknowledgedBy = assignments.get(check.pendingId)
      if (!check.acknowledgedBy && acknowledgedBy) {
        clearTimeout(check.deadline ?? undefined)
        check.deadline = null
        check.acknowledgedBy = acknowledgedBy
      }
    }
    const visibleOccurrences = new Set(promptSubmissions.map(occurrenceKey))
    deliveryChecksRef.current = deliveryChecksRef.current.filter(
      (check) =>
        !check.acknowledgedBy || visibleOccurrences.has(occurrenceKey(check.acknowledgedBy))
    )
  }, [promptSubmissions])

  useEffect(() => {
    if (!draftKey) {
      return
    }
    const relevant = deliveryChecksRef.current.filter(
      (check) =>
        check.draftKey === draftKey &&
        (check.pendingKey === null || check.pendingKey === pendingKey)
    )
    const landed = new Set(findLandedUnconfirmedSends(messages, relevant))
    if (landed.size === 0) {
      return
    }
    deliveryChecksRef.current = deliveryChecksRef.current.filter((check) => !landed.has(check))
    for (const check of landed) {
      clearTimeout(check.deadline ?? undefined)
    }
  }, [draftKey, messages, pendingKey])

  useEffect(
    () => () => {
      for (const check of deliveryChecksRef.current) {
        clearTimeout(check.deadline ?? undefined)
      }
      deliveryChecksRef.current = []
    },
    []
  )

  return {
    deliveryFailed: failureDraftKey === draftKey,
    acceptSend,
    readPromptSubmissionBaseline
  }
}
