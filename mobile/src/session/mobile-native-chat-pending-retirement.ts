import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  countImageSourceTurnsAfter,
  normalizeReconcileText,
  normalizedUserText
} from './mobile-native-chat-draft-reconcile'
import type { MobileNativeChatPendingMessage } from './mobile-native-chat-pending-echo'

const SPACE = ' '
const NO_PENDING_IDS: ReadonlySet<string> = new Set()
// Slack the cursor slide may spend re-trying later start positions, on top of
// one free pass over the run. Nothing bounds how many sends accumulate on the
// agent's input line — that ends when the agent accepts input again — so the
// budget must never truncate a genuine glue: the first attempt covers the whole
// run and always fits. It only stops a run of identical prefix-matching sends
// from making the scan quadratic.
export const GLUE_SLIDE_BUDGET = 8

type UserTurn = { index: number; text: string }
type GlueSegment = { text: string; tail: number } | null

/** Pending ids represented by post-send transcript rows that glued adjacent sends. */
export function selectGluedPendingIds(
  messages: readonly NativeChatMessage[],
  pending: readonly MobileNativeChatPendingMessage[],
  excludedPendingIds: ReadonlySet<string> = NO_PENDING_IDS,
  /** Image echoes whose local preview has been rebound onto its transcript row.
   *  Until that happens an image echo must stay put, so it is not a glue segment. */
  reboundImagePendingIds: ReadonlySet<string> = NO_PENDING_IDS
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
    // An image send glues onto the input line like any other, so once its preview is
    // rebound its text is a real segment of the resulting row. While it is still
    // unbound it stays a barrier: retiring it early would drop the phone-local photo,
    // which the transcript's host path cannot render.
    const unboundImage = Boolean(item.images?.length) && !reboundImagePendingIds.has(item.id)
    return excludedPendingIds.has(item.id) ||
      !item.baselineResolved ||
      unboundImage ||
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
      // A send that can never match must not freeze the run behind it. One
      // permanently unretirable head — a pair whose own glued row arrived with
      // the read, or a send the count pass claimed against an older row — would
      // otherwise disable glue retirement for every later pair, for the rest of
      // the session. Slide past it; the cursor stays monotonic, so a later turn
      // can never claim a send an earlier one already took.
      let budget = runEnd - runStart + GLUE_SLIDE_BUDGET
      let start = cursor
      let matched = 0
      for (; start <= runEnd - 2 && budget > 0; start++) {
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

/** Length of the exact glued run at `start`, plus the segments it had to read. */
function matchGluedRun(
  turn: UserTurn,
  segments: readonly GlueSegment[],
  start: number,
  end: number
): { matched: number; inspected: number } {
  let at = 0
  let matched = 0
  let inspected = 0
  for (let index = start; index < end; index++) {
    const segment = segments[index]!
    inspected += 1
    // Every send carries its OWN boundary: a row that already existed when this
    // send was issued can never be part of its echo, however well it reads.
    if (turn.index <= segment.tail) {
      return { matched: 0, inspected }
    }
    if (at > 0 && turn.text[at] === SPACE) {
      at += 1
    }
    if (!turn.text.startsWith(segment.text, at)) {
      return { matched: 0, inspected }
    }
    at += segment.text.length
    matched += 1
    if (at === turn.text.length) {
      // A lone exact match is an ordinary landing, which the count pass owns.
      return { matched: matched > 1 ? matched : 0, inspected }
    }
  }
  return { matched: 0, inspected }
}

/** Retires exact and glued transcript landings while preserving pending order. */
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
  // Why a separate set: a barrier preserves adjacency after a landing consumed a whole
  // row. An image landing can share its row with the send glued after it, so treating it
  // as a barrier would strand that send in a run of one and keep its echo forever.
  const exactLandedIds = new Set<string>()
  for (const item of current) {
    if (landedImagePendingIds.has(item.id)) {
      landedPendingIds.add(item.id)
      continue
    }
    // Keep image echoes until their local preview reaches the authoritative message.
    // An unresolved baseline has nothing to count against yet — `messages` is not
    // known to be the transcript this send was issued into.
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
