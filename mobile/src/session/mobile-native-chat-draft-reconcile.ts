import { isImageRefBlock, type NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  countImagePromptMarkers,
  hasImagePromptMarker,
  isImageSourceUserTurn,
  nativeChatUserMessageImageEvidenceCount,
  nativeChatUserMessageMatchText,
  nativeChatUserTextMatchText,
  normalizeImageTranscriptMessages,
  normalizedNativeChatUserMessageText
} from './mobile-native-chat-image-transcript-markers'

/** An ack-lost ('unknown' outcome) send held until its transcript echo lands or
 *  the deadline surfaces the uncertainty. */
export type UnconfirmedSend = {
  draftKey: string
  pendingKey: string | null
  text: string
  normalizedText: string
  imageCount: number
  baselineTailMessageId: string | null
  deadline: ReturnType<typeof setTimeout> | null
}

export function normalizedUserText(message: NativeChatMessage): string | null {
  return normalizedNativeChatUserMessageText(message)
}

export function countUserTextOccurrences(
  messages: readonly NativeChatMessage[],
  text: string,
  imageCount = 0
): number {
  let count = 0
  for (const message of normalizeImageTranscriptMessages(messages)) {
    const hasImageRefs = message.blocks.some(isImageRefBlock)
    const matchText =
      imageCount > 0
        ? normalizedNativeChatUserMessageText(message)
        : nativeChatUserMessageMatchText(message)
    if (
      matchText === text &&
      (imageCount > 0 || !hasImageRefs) &&
      nativeChatUserMessageImageEvidenceCount(message) >= imageCount
    ) {
      count++
    }
  }
  return count
}

/** Landed literal-text turns counted under the same key a markerless send uses.
 *  Image turns are excluded so they cannot retire a send that carried none. */
export function userTextOccurrenceCounts(
  messages: readonly NativeChatMessage[]
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const message of normalizeImageTranscriptMessages(messages)) {
    if (message.blocks.some(isImageRefBlock)) {
      continue
    }
    const text = nativeChatUserMessageMatchText(message)
    if (text) {
      counts.set(text, (counts.get(text) ?? 0) + 1)
    }
  }
  return counts
}

/** Number of `[Image: source: …]` echo turns strictly after `tailId` (or the
 *  whole transcript when the tail was paginated out). An image-only send has no
 *  caption to match, so it reconciles by ordinal against this count — counting
 *  only image echoes keeps an unrelated text send's echo from clearing it. */
export function countImageSourceTurnsAfter(
  messages: readonly NativeChatMessage[],
  tailId: string | null
): number {
  const tailIndex = tailId ? messages.findIndex((message) => message.id === tailId) : -1
  let count = 0
  for (let i = tailIndex + 1; i < messages.length; i++) {
    const message = messages[i]
    if (message && isImageSourceUserTurn(message)) {
      count++
    }
  }
  return count
}

export type PendingImagePreviewEcho = {
  id: string
  text: string
  images?: string[]
  expectedOccurrence: number
  baselineTailMessageId: string | null
}

export type LandedImagePreviewEcho = {
  pendingId: string
  messageId: string
  images: string[]
}

const SENT_IMAGE_PREVIEW_LIMIT = 32
const SENT_IMAGE_PREVIEW_SESSION_LIMIT = 8

export function mergeLandedImagePreviewEchoes(
  previous: Record<string, Record<string, string[]>>,
  sessionKey: string,
  landed: readonly LandedImagePreviewEcho[]
): Record<string, Record<string, string[]>> {
  const entries = Object.entries(previous[sessionKey] ?? {})
  for (const preview of landed) {
    const existingIndex = entries.findIndex(([messageId]) => messageId === preview.messageId)
    if (existingIndex !== -1) {
      entries.splice(existingIndex, 1)
    }
    entries.push([preview.messageId, preview.images])
  }
  const next = { ...previous }
  delete next[sessionKey]
  next[sessionKey] = Object.fromEntries(entries.slice(-SENT_IMAGE_PREVIEW_LIMIT))
  for (const key of Object.keys(next).slice(0, -SENT_IMAGE_PREVIEW_SESSION_LIMIT)) {
    delete next[key]
  }
  return next
}

function imagePreviewReplacementMessageId(
  messages: readonly NativeChatMessage[],
  sourceIndex: number
): string | null {
  const source = messages[sourceIndex]
  if (!source || !isImageSourceUserTurn(source)) {
    return null
  }
  let nextIndex = sourceIndex + 1
  while (
    messages[nextIndex]?.source === source.source &&
    isImageSourceUserTurn(messages[nextIndex]!)
  ) {
    nextIndex++
  }
  const prompt = messages[nextIndex]
  return prompt?.role === 'user' && prompt.source === source.source && hasImagePromptMarker(prompt)
    ? prompt.id
    : null
}

/** Moves previews forward when a progressive source-only transcript frame later
 *  folds into the marker-bearing prompt with a different authoritative id. */
export function migrateImagePreviewMessageIds(
  previous: Record<string, Record<string, string[]>>,
  sessionKey: string,
  messages: readonly NativeChatMessage[]
): Record<string, Record<string, string[]>> {
  const sessionPreviews = previous[sessionKey]
  if (!sessionPreviews) {
    return previous
  }
  const messageIndexById = new Map(messages.map((message, index) => [message.id, index]))
  let nextSession: Record<string, string[]> | null = null
  for (const [messageId, images] of Object.entries(sessionPreviews)) {
    const sourceIndex = messageIndexById.get(messageId)
    if (sourceIndex === undefined) {
      continue
    }
    const replacementId = imagePreviewReplacementMessageId(messages, sourceIndex)
    if (!replacementId) {
      continue
    }
    nextSession ??= { ...sessionPreviews }
    delete nextSession[messageId]
    nextSession[replacementId] = [...(nextSession[replacementId] ?? []), ...images]
  }
  return nextSession ? { ...previous, [sessionKey]: nextSession } : previous
}

/** Binds local preview URIs to the authoritative transcript turn that replaced
 *  the optimistic bubble. Host paths and marker-only Codex turns cannot render
 *  the phone-local photo without this handoff. */
export function findLandedImagePreviewEchoes(
  messages: readonly NativeChatMessage[],
  entries: readonly PendingImagePreviewEcho[]
): LandedImagePreviewEcho[] {
  const normalized = normalizeImageTranscriptMessages(messages)
  const messageIndexById = new Map(normalized.map((message, index) => [message.id, index]))
  const claimedMessageIds = new Set<string>()
  const landed: LandedImagePreviewEcho[] = []

  for (const entry of entries) {
    if (!entry.images?.length) {
      continue
    }
    const targetText = nativeChatUserTextMatchText(entry.text, true)
    const candidates = normalized.filter((message) => {
      if (message.role !== 'user') {
        return false
      }
      const imageCount = nativeChatUserMessageImageEvidenceCount(message)
      if (targetText) {
        return (
          normalizedNativeChatUserMessageText(message) === targetText &&
          imageCount >= entry.images!.length
        )
      }
      const imageRefCount = message.blocks.filter(isImageRefBlock).length
      // Why: a marker-only echo proves delivery per marker, so a partially
      // rendered turn must not claim (and rebind) previews it cannot account for.
      return (
        message.blocks.length === 0 ||
        imageRefCount >= entry.images!.length ||
        (countImagePromptMarkers(message) >= entry.images!.length &&
          normalizedUserText(message) === null)
      )
    })
    const tailIndex = entry.baselineTailMessageId
      ? messageIndexById.get(entry.baselineTailMessageId)
      : -1
    const occurrenceIndex = Math.max(0, entry.expectedOccurrence - 1)
    const candidate = targetText
      ? candidates[occurrenceIndex]
      : candidates.filter(
          (message) =>
            tailIndex === undefined || (messageIndexById.get(message.id) ?? -1) > tailIndex
        )[occurrenceIndex]
    if (
      !candidate ||
      claimedMessageIds.has(candidate.id) ||
      (tailIndex !== undefined && (messageIndexById.get(candidate.id) ?? -1) <= tailIndex)
    ) {
      continue
    }
    claimedMessageIds.add(candidate.id)
    landed.push({ pendingId: entry.id, messageId: candidate.id, images: entry.images })
  }
  return landed
}

export function findLandedUnconfirmedSends(
  messages: readonly NativeChatMessage[],
  entries: readonly UnconfirmedSend[]
): UnconfirmedSend[] {
  // Why: pagination prepends old equal text; only unclaimed matches after each
  // captured tail prove new echoes. User turns are keyed by text; an image echo
  // (`[Image: source: …]` or no text) keys under '' so an empty-text send can
  // claim it.
  const messageIndexById = new Map(messages.map((message, index) => [message.id, index]))
  type EchoCandidate = {
    id: string
    index: number
    imageCount: number
    /** The host kept no content for this turn, so it testifies to no particular
     *  number of images — it can stand for a send of any size. */
    countUnknown?: boolean
  }
  const literalMessagesByText = new Map<string, EchoCandidate[]>()
  const imageMessagesByText = new Map<string, EchoCandidate[]>()
  for (const message of normalizeImageTranscriptMessages(messages)) {
    const index = messageIndexById.get(message.id)
    if (index === undefined) {
      continue
    }
    if (message.role !== 'user') {
      continue
    }
    const isImageSource = isImageSourceUserTurn(message)
    const imageCount = nativeChatUserMessageImageEvidenceCount(message)
    // A turn the host echoed with nothing at all is the compatibility shape for
    // an image send it kept no text for. Its evidence count is 0, so requiring
    // the count to cover the send would hold that send open until the deadline
    // fired a false "delivery unknown" — while the sibling preview-binding path
    // accepts exactly this shape and binds the photo. Keys under '' either way,
    // so only a captionless send can reach it.
    const countUnknown = message.blocks.length === 0
    const candidate: EchoCandidate = {
      id: message.id,
      index,
      imageCount,
      ...(countUnknown ? { countUnknown } : {})
    }
    if (!message.blocks.some(isImageRefBlock)) {
      const literalKey = isImageSource ? '' : (nativeChatUserMessageMatchText(message) ?? '')
      const current = literalMessagesByText.get(literalKey) ?? []
      current.push(candidate)
      literalMessagesByText.set(literalKey, current)
    }
    if (imageCount > 0 || countUnknown) {
      const imageKey = isImageSource ? '' : (normalizedUserText(message) ?? '')
      const current = imageMessagesByText.get(imageKey) ?? []
      current.push(candidate)
      imageMessagesByText.set(imageKey, current)
    }
  }

  const claimedMessageIds = new Set<string>()
  const landed: UnconfirmedSend[] = []
  for (const entry of entries) {
    const tailIndex = entry.baselineTailMessageId
      ? messageIndexById.get(entry.baselineTailMessageId)
      : -1
    if (tailIndex === undefined) {
      continue
    }
    const messagesByText = entry.imageCount > 0 ? imageMessagesByText : literalMessagesByText
    const echo = messagesByText
      .get(entry.normalizedText)
      ?.find(
        (message) =>
          message.index > tailIndex &&
          (message.countUnknown === true || message.imageCount >= entry.imageCount) &&
          !claimedMessageIds.has(message.id)
      )
    if (echo) {
      claimedMessageIds.add(echo.id)
      landed.push(entry)
    }
  }
  return landed
}
