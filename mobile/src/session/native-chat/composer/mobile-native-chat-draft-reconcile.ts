import {
  isImageRefBlock,
  type NativeChatMessage
} from '../../../../../src/shared/native-chat-types'
import {
  hasImagePromptMarker,
  isImageSourceUserTurn,
  normalizeImageTranscriptMessages,
  normalizeNativeChatUserText,
  normalizedNativeChatUserMessageText
} from '../../../../../src/shared/native-chat/transcript/native-chat-image-transcript-markers'
import { nativeChatPendingOccurrence } from '../../../../../src/shared/native-chat-pending-occurrence'
import type { NativeChatPendingSend } from '../../../../../src/shared/native-chat-pending-sends'

export type UnconfirmedSend = {
  draftKey: string
  pendingKey: string | null
  text: string
  normalizedText: string
  baselineTailMessageId: string | null
  deadline: ReturnType<typeof setTimeout> | null
}

export function normalizedUserText(message: NativeChatMessage): string | null {
  return normalizedNativeChatUserMessageText(message)
}

export type PendingImagePreviewEcho = Pick<
  NativeChatPendingSend,
  'id' | 'text' | 'sentAt' | 'afterMessageId' | 'matchingOccurrence'
> & { images?: string[] }

export type SentImagePreview = {
  messageId: string
  images: string[]
}

export type LandedImagePreviewEcho = SentImagePreview & { pendingId: string }

const SENT_IMAGE_PREVIEW_LIMIT = 32
const SENT_IMAGE_PREVIEW_SESSION_LIMIT = 8

export function mergeSentImagePreviews(
  previous: Record<string, Record<string, string[]>>,
  sessionKey: string,
  previews: readonly SentImagePreview[]
): Record<string, Record<string, string[]>> {
  const entries = Object.entries(previous[sessionKey] ?? {})
  for (const preview of previews) {
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

// Move local previews when progressive source-only rows fold into a new marker-bearing authoritative id.
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

// A boundary on an image-source row lives on in the prompt row it folded into.
function foldedBoundaryIndex(
  messages: readonly NativeChatMessage[],
  normalizedIndexById: ReadonlyMap<string, number>,
  boundaryId: string | null | undefined
): number | undefined {
  if (!boundaryId) {
    return -1
  }
  const direct = normalizedIndexById.get(boundaryId)
  if (direct !== undefined) {
    return direct
  }
  const rawIndex = messages.findIndex((message) => message.id === boundaryId)
  const promptId = rawIndex === -1 ? null : imagePreviewReplacementMessageId(messages, rawIndex)
  return promptId ? normalizedIndexById.get(promptId) : undefined
}

// Carry phone-local preview URIs onto authoritative rows because host paths/marker-only turns cannot display those photos.
export function findLandedImagePreviewEchoes(
  messages: readonly NativeChatMessage[],
  entries: readonly PendingImagePreviewEcho[]
): LandedImagePreviewEcho[] {
  const normalized = normalizeImageTranscriptMessages(messages)
  const messageIndexById = new Map(normalized.map((message, index) => [message.id, index]))
  // Use raw image-marker provenance; normalized text alone could misidentify a caption-prefix match.
  const imageMessageIds = new Set(
    messages
      .filter(
        (message) =>
          message.role === 'user' &&
          (isImageSourceUserTurn(message) ||
            hasImagePromptMarker(message) ||
            message.blocks.some(isImageRefBlock))
      )
      .map((message) => message.id)
  )
  const claimedMessageIds = new Set<string>()
  const landed: LandedImagePreviewEcho[] = []

  for (const entry of entries) {
    if (!entry.images?.length) {
      continue
    }
    const targetText = normalizeNativeChatUserText(entry.text)
    const candidates = normalized.filter((message) => {
      if (message.role !== 'user') {
        return false
      }
      if (targetText) {
        const text = normalizedUserText(message)
        if (text === null) {
          return false
        }
        // Adjacent TUI sends may concatenate; allow prefix matches only for proven image rows or image echoes can never retire.
        return (
          text === targetText || (imageMessageIds.has(message.id) && text.startsWith(targetText))
        )
      }
      const imageCount = message.blocks.filter(isImageRefBlock).length
      return message.blocks.length === 0 || imageCount >= entry.images!.length
    })
    const tailIndex = foldedBoundaryIndex(messages, messageIndexById, entry.afterMessageId)
    // Same boundary-relative occurrence as the shared pending rule, so older identical rows cannot bind.
    const candidate = candidates.filter(
      (message) => tailIndex === undefined || (messageIndexById.get(message.id) ?? -1) > tailIndex
    )[nativeChatPendingOccurrence(entry, 0) - 1]
    if (!candidate || claimedMessageIds.has(candidate.id)) {
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
  // Only unclaimed echoes after the captured tail prove new sends; prepended equal history must not count. Image echoes use the empty-text key.
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
