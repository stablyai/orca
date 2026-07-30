import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  isImageSourceUserTurn,
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
