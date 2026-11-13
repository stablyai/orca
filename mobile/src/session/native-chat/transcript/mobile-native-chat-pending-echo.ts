import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import type { MobileNativeChatDraftDestination } from '../composer/mobile-native-chat-draft-inputs'
import {
  assignNativeChatPendingOccurrence,
  nativeChatPendingContentKey
} from '../../../../../src/shared/native-chat/transcript/native-chat-pending-occurrence'
import {
  NATIVE_CHAT_PENDING_SEND_LIMIT,
  nativeChatPendingSendPlacement
} from '../../../../../src/shared/native-chat/transcript/native-chat-pending-sends'
import {
  mobileNativeChatLegacyPendingSummary,
  type MobileNativeChatLegacyPending
} from '../mobile-native-chat-legacy-pending'

export type MobileNativeChatPendingMessage = MobileNativeChatLegacyPending & {
  // Phone-local preview URIs; these echoes retire only once their preview binds to a transcript row.
  images?: string[]
}

export type MobileNativeChatSendOrigin = {
  draftKey: string
  draftDestination: MobileNativeChatDraftDestination
  draftEditGeneration: number
  pendingKey: string | null
  normalizedText: string
  boundary: Pick<
    MobileNativeChatLegacyPending,
    'afterMessageId' | 'afterMessageTimestamp' | 'afterEmptyTranscriptSessionId'
  >
  sentAt: number
  queuedDuringWorkingEpoch?: number | null
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
  const entry = assignNativeChatPendingOccurrence<MobileNativeChatPendingMessage>(current, {
    id,
    text,
    sentAt: origin.sentAt,
    queuedDuringWorkingEpoch: origin.queuedDuringWorkingEpoch,
    ...origin.boundary,
    ...(images?.length ? { images } : {})
  })
  return { ...previous, [key]: [...current, entry].slice(-NATIVE_CHAT_PENDING_SEND_LIMIT) }
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

export function retireLandedMobileNativeChatPending(
  messages: readonly NativeChatMessage[],
  current: MobileNativeChatPendingMessage[],
  landedImagePendingIds: ReadonlySet<string>
): MobileNativeChatPendingMessage[] {
  const { retained } = mobileNativeChatLegacyPendingSummary(current, messages)
  const kept = new Map(
    current.filter((item) => retained.has(item.id)).map((item) => [item.id, item])
  )
  let changed = false
  const next = current.flatMap((item) => {
    const survivor = kept.get(item.id)
    if (landedImagePendingIds.has(item.id)) {
      changed = true
      // The preview now lives on its row; a caption stays a plain send so it can retire with glued neighbours.
      if (!survivor || nativeChatPendingContentKey(item) === 'empty') {
        return []
      }
      const { images: _bound, ...caption } = survivor
      return [caption]
    }
    if (survivor || item.images?.length) {
      return [survivor ?? item]
    }
    changed = true
    return []
  })
  return changed ? next : current
}

export function visibleMobileNativeChatPending(
  messages: readonly NativeChatMessage[],
  current: MobileNativeChatPendingMessage[]
): MobileNativeChatPendingMessage[] {
  const { visible } = mobileNativeChatLegacyPendingSummary(current, messages)
  const next = current.filter((item) => visible.has(item.id) || Boolean(item.images?.length))
  return next.length === current.length ? current : next
}

export function mobileNativeChatPendingAsMessages(
  pending: MobileNativeChatPendingMessage[],
  messages: readonly NativeChatMessage[],
  workingEpoch?: number | null
): NativeChatMessage[] {
  const { visible } = mobileNativeChatLegacyPendingSummary(pending, messages)
  return pending
    .filter((entry) => visible.has(entry.id))
    .map((entry) => ({
      id: `pending:${entry.id}`,
      role: 'user',
      blocks: entry.text.trim() ? [{ type: 'text', text: entry.text }] : [],
      timestamp: entry.sentAt,
      pendingSend: nativeChatPendingSendPlacement(entry, workingEpoch),
      source: 'scrape'
    }))
}
