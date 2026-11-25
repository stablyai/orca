import { journalItemsById } from './agent-session-journal-item-index'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { compareAgentJournalItems } from '../../../../../shared/agent-session/journal/agent-session-journal-position'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalBatch } from '../../../../../shared/agent-session/agent-session-wire'
import { isStructuredAgentSessionStopNote } from '../../operations/structured-agent-session-command-turn'
import { findSequenceGap } from '../../../agent-session-journal/replay/journal-cursor'
import type { JournalReadRow } from '../../../agent-session-journal/replay/journal-read-row'
import { isJournalStopOrResumeRow } from '../../../agent-session-journal/durable-rows/journal-row-schema'
// Project touched items at current reduced state for idempotent delivery; adopted echoes retain submission keys.

export type JournalBatchProjection =
  | { ok: true; batch: AgentSessionJournalBatch }
  /** Reload on gaps instead of rendering partial history. */
  | { ok: false; reset: 'journal_gap' }

export function projectJournalBatch(input: {
  rows: readonly JournalReadRow[]
  snapshot: AgentJournalSnapshot
  afterSequence: number
  canonicalItemId?: (itemId: string) => string
  hasSubmission?: (id: string) => boolean
  queueSourceIds?: (messageId: string) => readonly string[]
  stopNoteIds?: (turnItemIds: ReadonlySet<string>) => readonly string[]
  readSnapshot?: (touched: Set<string>) => AgentJournalSnapshot
}): JournalBatchProjection {
  if (
    input.rows.every((row) => row.kind !== 'outcome') &&
    findSequenceGap(
      input.rows.map((row) => row.seq),
      input.afterSequence + 1
    )
  ) {
    return { ok: false, reset: 'journal_gap' }
  }
  const aliases = input.canonicalItemId ? undefined : submissionAliases(input.snapshot.submissions)
  const touchedItemIds = new Set<string>()
  for (const row of input.rows) {
    if (row.kind === 'outcome') {
      for (const itemId of row.itemIds) {
        touchedItemIds.add(input.canonicalItemId?.(itemId) ?? aliases?.get(itemId) ?? itemId)
      }
      for (const clientMessageId of row.submissionIds) {
        touchedItemIds.add(agentJournalSubmissionKey(clientMessageId))
      }
      continue
    }
    if (row.kind === 'lifecycle-batch') {
      for (const mutation of row.mutations) {
        touchedItemIds.add(
          input.canonicalItemId?.(mutation.itemId) ??
            aliases?.get(mutation.itemId) ??
            mutation.itemId
        )
      }
      continue
    }
    if (isJournalStopOrResumeRow(row)) {
      // Stop/Resume markers are host-only; publish derived queue pauses separately.
      continue
    }
    if (row.kind === 'item' || row.kind === 'tombstone') {
      touchedItemIds.add(
        input.canonicalItemId?.(row.itemId) ?? aliases?.get(row.itemId) ?? row.itemId
      )
      continue
    }
    if (row.kind === 'queue') {
      for (const id of input.queueSourceIds?.(row.messageId) ?? []) {
        touchedItemIds.add(agentJournalSubmissionKey(id))
      }
    }
    // A card's row naming its hand-off can change how that send reads (`foldQueuedHandOffInDoubt`).
    const attempt =
      row.kind === 'queue' && row.change.op === 'queued'
        ? (row.change.attempt ?? row.change.recovers)
        : undefined
    const clientMessageId =
      row.kind === 'submission' || row.kind === 'dispatch'
        ? row.clientMessageId
        : attempt === undefined
          ? undefined
          : (input.hasSubmission?.(attempt) ??
              input.snapshot.submissions.some(
                (submission) => submission.clientMessageId === attempt
              ))
            ? attempt
            : undefined
    if (clientMessageId !== undefined) {
      touchedItemIds.add(agentJournalSubmissionKey(clientMessageId))
    }
  }

  if (input.stopNoteIds) {
    for (const noteId of input.stopNoteIds(touchedItemIds)) {
      touchedItemIds.add(noteId)
    }
  } else {
    const notes = stopNotesByTurn(input.snapshot.items)
    for (const itemId of touchedItemIds) {
      for (const noteId of notes.get(itemId) ?? []) {
        touchedItemIds.add(noteId)
      }
    }
  }
  const snapshot = input.readSnapshot?.(touchedItemIds) ?? input.snapshot
  const live = journalItemsById(snapshot.items)
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
      submissions: snapshot.submissions.filter((submission) =>
        touchedItemIds.has(agentJournalSubmissionKey(submission.clientMessageId))
      )
    }
  }
}

// Snapshot arrays invalidate these indexes; catch-up pages and byte-shrink retries reuse them.
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
    // Re-emit projected Stop notes on turn removal even if their failure field is already absent.
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

/** Derive aliases from published acceptance so projection stays independent of reducer internals. */
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
