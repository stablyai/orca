import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  countImageSourceTurnsAfter,
  normalizeReconcileText,
  normalizedUserText
} from './mobile-native-chat-draft-reconcile'
import type { MobileNativeChatPendingMessage } from './mobile-native-chat-pending-echo'

const SPACE = ' '
const NO_PENDING_IDS: ReadonlySet<string> = new Set()

type UserTurn = { index: number; text: string }
type GlueSegment = { text: string; tail: number } | null

/** Pending ids represented by post-send transcript rows that glued adjacent sends. */
export function selectGluedPendingIds(
  messages: readonly NativeChatMessage[],
  pending: readonly MobileNativeChatPendingMessage[],
  excludedPendingIds: ReadonlySet<string> = NO_PENDING_IDS
): ReadonlySet<string> {
  const retired = new Set<string>()
  if (pending.length < 2) {
    return retired
  }
  const messageIndexById = new Map<string, number>()
  const turns: UserTurn[] = []
  for (const [index, message] of messages.entries()) {
    messageIndexById.set(message.id, index)
    const text = normalizedUserText(message)
    if (text) {
      turns.push({ index, text })
    }
  }
  const segments: GlueSegment[] = pending.map((item) => {
    const text = normalizeReconcileText(item.text)
    const tail =
      item.baselineTailMessageId === null
        ? -1
        : (messageIndexById.get(item.baselineTailMessageId) ?? null)
    return excludedPendingIds.has(item.id) ||
      !item.glueBaselineTrusted ||
      item.images?.length ||
      text === '' ||
      tail === null
      ? null
      : { text, tail }
  })

  // Barriers preserve original adjacency after exact landings retire.
  let runStart = 0
  while (runStart < pending.length) {
    while (runStart < pending.length && segments[runStart] === null) {
      runStart += 1
    }
    let runEnd = runStart
    while (runEnd < pending.length && segments[runEnd] !== null) {
      runEnd += 1
    }
    let cursor = runStart
    for (const turn of turns) {
      if (cursor >= runEnd - 1) {
        break
      }
      const matched = matchGluedRun(turn, segments, cursor, runEnd)
      if (matched === 0) {
        continue
      }
      for (let index = cursor; index < cursor + matched; index++) {
        retired.add(pending[index]!.id)
      }
      cursor += matched
    }
    runStart = runEnd + 1
  }
  return retired
}

/** Length of the exact glued run at `start`, or zero. */
function matchGluedRun(
  turn: UserTurn,
  segments: readonly GlueSegment[],
  start: number,
  end: number
): number {
  let at = 0
  let matched = 0
  for (let index = start; index < end; index++) {
    const segment = segments[index]!
    if (turn.index <= segment.tail) {
      return 0
    }
    if (at > 0 && turn.text[at] === SPACE) {
      at += 1
    }
    if (!turn.text.startsWith(segment.text, at)) {
      return 0
    }
    at += segment.text.length
    matched += 1
    if (at === turn.text.length) {
      // A lone exact match is an ordinary landing, which the count pass owns.
      return matched > 1 ? matched : 0
    }
  }
  return 0
}

/** Retires exact and glued transcript landings while preserving pending order. */
export function retireLandedMobileNativeChatPending(
  messages: readonly NativeChatMessage[],
  current: readonly MobileNativeChatPendingMessage[],
  landedImagePendingIds: ReadonlySet<string>
): MobileNativeChatPendingMessage[] {
  const landedCounts = new Map<string, number>()
  for (const message of messages) {
    const text = normalizedUserText(message)
    if (text) {
      landedCounts.set(text, (landedCounts.get(text) ?? 0) + 1)
    }
  }
  const landedPendingIds = new Set<string>()
  for (const item of current) {
    if (landedImagePendingIds.has(item.id)) {
      landedPendingIds.add(item.id)
      continue
    }
    // Keep image echoes until their local preview reaches the authoritative message.
    if (item.images?.length) {
      continue
    }
    const landed =
      item.text.trim() === ''
        ? countImageSourceTurnsAfter(messages, item.baselineTailMessageId) >=
          item.expectedOccurrence
        : (landedCounts.get(normalizeReconcileText(item.text)) ?? 0) >= item.expectedOccurrence
    if (landed) {
      landedPendingIds.add(item.id)
    }
  }
  const glued = selectGluedPendingIds(messages, current, landedPendingIds)
  return landedPendingIds.size === 0 && glued.size === 0
    ? [...current]
    : current.filter((item) => !landedPendingIds.has(item.id) && !glued.has(item.id))
}
