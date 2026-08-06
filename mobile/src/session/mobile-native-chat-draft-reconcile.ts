import { isImageRefBlock, type NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  isImageSourceUserTurn,
  normalizeImageTranscriptMessages,
  stripImagePromptMarker
} from './mobile-native-chat-image-transcript-markers'

/** An ack-lost ('unknown' outcome) send held until its transcript echo lands or
 *  the deadline surfaces the uncertainty. */
export type UnconfirmedSend = {
  draftKey: string
  pendingKey: string | null
  text: string
  normalizedText: string
  baselineTailMessageId: string | null
  deadline: ReturnType<typeof setTimeout> | null
}

export function normalizedUserText(message: NativeChatMessage): string | null {
  if (message.role !== 'user') {
    return null
  }
  const text = message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
  // Claude echoes a captioned image send as `[Image #1] caption` — the sent
  // text must still match its echo, so strip the marker before comparing.
  const stripped = stripImagePromptMarker(text).trim()
  return stripped || null
}

export function countUserTextOccurrences(
  messages: readonly NativeChatMessage[],
  text: string
): number {
  let count = 0
  for (const message of messages) {
    if (normalizedUserText(message) === text) {
      count++
    }
  }
  return count
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
    if (existingIndex >= 0) {
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
  const firstText = prompt?.blocks.find((block) => block.type === 'text')
  return prompt?.role === 'user' &&
    prompt.source === source.source &&
    firstText?.type === 'text' &&
    stripImagePromptMarker(firstText.text) !== firstText.text
    ? prompt.id
    : null
}

/** Moves previews forward when a progressive source-only transcript frame later
 *  folds into the marker-prefixed prompt with a different authoritative id. */
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
    const targetText = entry.text.trim()
    const candidates = normalized.filter((message) => {
      if (message.role !== 'user') {
        return false
      }
      if (targetText) {
        return normalizedUserText(message) === targetText
      }
      const imageCount = message.blocks.filter(isImageRefBlock).length
      return message.blocks.length === 0 || imageCount >= entry.images!.length
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
  const messageIndexById = new Map<string, number>()
  const userMessagesByText = new Map<string, Array<{ id: string; index: number }>>()
  for (const [index, message] of messages.entries()) {
    messageIndexById.set(message.id, index)
    if (message.role !== 'user') {
      continue
    }
    const key = isImageSourceUserTurn(message) ? '' : (normalizedUserText(message) ?? '')
    const current = userMessagesByText.get(key) ?? []
    current.push({ id: message.id, index })
    userMessagesByText.set(key, current)
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
    const echo = userMessagesByText
      .get(entry.normalizedText)
      ?.find((message) => message.index > tailIndex && !claimedMessageIds.has(message.id))
    if (echo) {
      claimedMessageIds.add(echo.id)
      landed.push(entry)
    }
  }
  return landed
}
