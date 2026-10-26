import { nativeChatContinuationSendText } from '../../../src/shared/native-chat-continuation-send'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  countImageSourceTurnsAfter,
  normalizedUserText
} from './mobile-native-chat-draft-reconcile'
import { normalizeNativeChatUserText as normalizeReconcileText } from '../../../src/shared/native-chat-image-transcript-markers'
import type { MobileNativeChatPendingMessage } from './mobile-native-chat-pending-echo'

const SPACE = ' '
const NO_PENDING_IDS: ReadonlySet<string> = new Set()
// Allow one full run plus retry slack so prefix collisions stay linear without truncating a genuine long concatenation.
export const GLUE_SLIDE_BUDGET = 8

type UserTurn = { index: number; text: string }
type GlueSegment = { text: string; literal: string; tail: number; continuation: boolean } | null

export function selectGluedPendingIds(
  messages: readonly NativeChatMessage[],
  pending: readonly MobileNativeChatPendingMessage[],
  excludedPendingIds: ReadonlySet<string> = NO_PENDING_IDS,
  // Only rebound image previews may retire; otherwise their local photos would disappear.
  reboundImagePendingIds: ReadonlySet<string> = NO_PENDING_IDS
): ReadonlySet<string> {
  const retired = new Set<string>()
  if (pending.length < 2 && !pending.some((item) => nativeChatContinuationSendText(item.text))) {
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
    const continuation = nativeChatContinuationSendText(item.text)
    const text = continuation ?? normalizeReconcileText(item.text)
    const tail =
      item.baselineTailMessageId === null
        ? -1
        : (messageIndexById.get(item.baselineTailMessageId) ?? null)
    // Unbound image echoes remain barriers because the phone cannot display the host path after losing its local preview.
    const unboundImage = Boolean(item.images?.length) && !reboundImagePendingIds.has(item.id)
    return excludedPendingIds.has(item.id) ||
      !item.baselineResolved ||
      unboundImage ||
      text === '' ||
      tail === null
      ? null
      : {
          text,
          literal: normalizeReconcileText(item.text),
          tail,
          continuation: continuation !== null
        }
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
      if (cursor >= runEnd) {
        break
      }
      // Slide past unmatchable heads so later sends can retire; keep the cursor monotonic so turns cannot reclaim sends.
      let budget = runEnd - runStart + GLUE_SLIDE_BUDGET
      let start = cursor
      let matched = 0
      for (; start < runEnd && budget > 0; start++) {
        const attempt = matchGluedRun(turn, segments, start, runEnd)
        budget -= attempt.inspected
        matched = attempt.matched
        if (matched > 0) {
          break
        }
      }
      if (matched === 0) {
        continue
      }
      for (let index = start; index < start + matched; index++) {
        retired.add(pending[index]!.id)
      }
      cursor = start + matched
    }
    runStart = runEnd + 1
  }
  return retired
}

function matchGluedRun(
  turn: UserTurn,
  segments: readonly GlueSegment[],
  start: number,
  end: number
): { matched: number; inspected: number } {
  let at = 0
  let matched = 0
  let opened = 0
  let inspected = 0
  for (let index = start; index < end; index++) {
    const segment = segments[index]!
    inspected += 1
    // Enforce each send’s captured tail even when an older row’s text matches exactly.
    if (turn.index <= segment.tail) {
      return { matched: opened, inspected }
    }
    if (at > 0 && turn.text[at] === SPACE) {
      at += 1
    }
    const literal = segment.continuation && turn.text.startsWith(segment.literal, at)
    const text = literal ? segment.literal : segment.text
    if (!turn.text.startsWith(text, at)) {
      return { matched: opened, inspected }
    }
    at += text.length
    matched += 1
    if (segment.continuation && !literal && (at === turn.text.length || turn.text[at] === SPACE)) {
      opened = matched
    }
    if (at === turn.text.length) {
      // The count pass owns ordinary single-send matches.
      return { matched: matched > 1 ? matched : opened, inspected }
    }
  }
  return { matched: opened, inspected }
}

export function retireLandedMobileNativeChatPending(
  messages: readonly NativeChatMessage[],
  current: MobileNativeChatPendingMessage[],
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
  // Only exact whole-row landings break adjacency; rebound image rows may also contain the following glued send.
  const exactLandedIds = new Set<string>()
  for (const item of current) {
    if (landedImagePendingIds.has(item.id)) {
      landedPendingIds.add(item.id)
      continue
    }
    // Keep local-image echoes until previews bind, and unresolved sends until their transcript baseline is known.
    if (item.images?.length || !item.baselineResolved) {
      continue
    }
    const landed =
      item.text.trim() === ''
        ? countImageSourceTurnsAfter(messages, item.baselineTailMessageId) >=
          item.expectedOccurrence
        : (landedCounts.get(normalizeReconcileText(item.text)) ?? 0) >= item.expectedOccurrence
    if (landed) {
      landedPendingIds.add(item.id)
      exactLandedIds.add(item.id)
    }
  }
  const glued = selectGluedPendingIds(messages, current, exactLandedIds, landedImagePendingIds)
  return landedPendingIds.size === 0 && glued.size === 0
    ? current
    : current.filter((item) => !landedPendingIds.has(item.id) && !glued.has(item.id))
}
