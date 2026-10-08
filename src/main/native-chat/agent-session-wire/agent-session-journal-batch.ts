// Rows appended since a cursor, projected into what a subscriber must apply.
//
// The batch carries each touched item at its CURRENT reduced state rather than
// the raw rows: a client that applies the same batch twice converges, and a
// provider echo that was adopted into a submission slot arrives under the slot
// key instead of appearing as a second copy of the user's own message.

import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournalBatch } from '../../../shared/agent-session-wire'
import { isStructuredAgentSessionStopNote } from './structured-agent-session-command-turn'
import { findSequenceGap } from '../agent-session-journal/journal-cursor'
import {
  isJournalStopOrResumeRow,
  type JournalRow
} from '../agent-session-journal/journal-row-schema'

export type JournalBatchProjection =
  | { ok: true; batch: AgentSessionJournalBatch }
  /** A missing sequence means the tail lost a row; the subscriber reloads
   *  rather than rendering a timeline with a hole in it. */
  | { ok: false; reset: 'journal_gap' }

export function projectJournalBatch(input: {
  rows: readonly JournalRow[]
  snapshot: AgentJournalSnapshot
  /** Sequence the subscriber has already applied. */
  afterSequence: number
  canonicalItemId?: (itemId: string) => string
}): JournalBatchProjection {
  const gap = findSequenceGap(
    input.rows.map((row) => row.seq),
    input.afterSequence + 1
  )
  if (gap) {
    return { ok: false, reset: 'journal_gap' }
  }
  const aliases = submissionAliases(input.snapshot.submissions)
  const touchedItemIds = new Set<string>()
  const touchedClientMessageIds = new Set<string>()
  for (const row of input.rows) {
    if (row.kind === 'lifecycle-batch') {
      for (const mutation of row.mutations) {
        touchedItemIds.add(
          input.canonicalItemId?.(mutation.itemId) ??
            aliases.get(mutation.itemId) ??
            mutation.itemId
        )
      }
      continue
    }
    if (isJournalStopOrResumeRow(row)) {
      // Host-only: no item; the queue pause it feeds is published beside the list.
      continue
    }
    if (row.kind === 'item' || row.kind === 'tombstone') {
      touchedItemIds.add(
        input.canonicalItemId?.(row.itemId) ?? aliases.get(row.itemId) ?? row.itemId
      )
      continue
    }
    if (row.kind === 'submission' || row.kind === 'dispatch') {
      touchedClientMessageIds.add(row.clientMessageId)
      touchedItemIds.add(agentJournalSubmissionKey(row.clientMessageId))
    }
  }

  const live = liveItemsById(input.snapshot.items)
  const notes = stopNotesByTurn(input.snapshot.items)
  for (const itemId of touchedItemIds) {
    for (const noteId of notes.get(itemId) ?? []) {
      touchedItemIds.add(noteId)
    }
  }
  const items = [...touchedItemIds]
    .map((itemId) => live.get(itemId))
    .filter((item) => item !== undefined)
    .sort(compareAgentJournalItems)
  return {
    ok: true,
    batch: {
      cursor: input.snapshot.cursor,
      items,
      removedItemIds: [...touchedItemIds].filter((itemId) => !live.has(itemId)),
      submissions: input.snapshot.submissions.filter((submission) =>
        touchedClientMessageIds.has(submission.clientMessageId)
      )
    }
  }
}

// The indexes are keyed on the snapshot arrays themselves, which the reducer
// rebuilds on every change, so a paged catch-up over one snapshot pays for them
// once instead of once per page — including the byte-shrink loop's re-projections.
const liveItemsByTimeline = new WeakMap<
  readonly AgentJournalRenderItem[],
  ReadonlyMap<string, AgentJournalRenderItem>
>()
const aliasesBySubmissions = new WeakMap<
  readonly AgentJournalSubmission[],
  ReadonlyMap<string, string>
>()
const stopNotesByTimeline = new WeakMap<
  readonly AgentJournalRenderItem[],
  ReadonlyMap<string, readonly string[]>
>()

function stopNotesByTurn(
  items: readonly AgentJournalRenderItem[]
): ReadonlyMap<string, readonly string[]> {
  const cached = stopNotesByTimeline.get(items)
  if (cached) {
    return cached
  }
  const notes = new Map<string, string[]>()
  for (const item of items) {
    // Every Stop note is a status row. Not filtered on its failure: a note already projected
    // without one must still re-emit when its turn row is removed.
    if (
      item.body.kind === 'status' &&
      item.turnScope?.kind === 'turn' &&
      isStructuredAgentSessionStopNote(item.itemId)
    ) {
      const turnItemId = item.turnScope.turnItemId
      const ids = notes.get(turnItemId) ?? []
      ids.push(item.itemId)
      notes.set(turnItemId, ids)
    }
  }
  stopNotesByTimeline.set(items, notes)
  return notes
}

function liveItemsById(
  items: readonly AgentJournalRenderItem[]
): ReadonlyMap<string, AgentJournalRenderItem> {
  const cached = liveItemsByTimeline.get(items)
  if (cached) {
    return cached
  }
  const live = new Map(items.map((item) => [item.itemId, item]))
  liveItemsByTimeline.set(items, live)
  return live
}

/**
 * Provider item id → the submission slot that adopted it, rebuilt from the
 * snapshot's own accepted submissions. This mirrors the alias the reducer
 * writes on an accepted dispatch; deriving it here keeps the projection a pure
 * function of published state instead of reaching into reducer internals.
 */
function submissionAliases(
  submissions: readonly AgentJournalSubmission[]
): ReadonlyMap<string, string> {
  const cached = aliasesBySubmissions.get(submissions)
  if (cached) {
    return cached
  }
  const aliases = new Map<string, string>()
  for (const submission of submissions) {
    if (submission.dispatchState === 'accepted' && submission.providerItemId) {
      aliases.set(submission.providerItemId, agentJournalSubmissionKey(submission.clientMessageId))
    }
  }
  aliasesBySubmissions.set(submissions, aliases)
  return aliases
}
