// THE reducer. One implementation folds rows into the render model, and both
// the live append path and replay call it — a live-only shortcut is how a
// reconnect starts disagreeing with the screen it replaced.
//
// Rules: highest revision wins, a tombstone removes, a late lower revision is
// dropped rather than resurrecting stale content, and ordering is by the
// sequence of the row that CREATED an item (a later revision updates the body,
// it does not move the bubble).

import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { JournalRow } from './journal-row-schema'

export type JournalReducerState = {
  sessionId: string
  epoch: string
  lastSequence: number
  /** Lowest sequence still individually replayable; rows below it were compacted. */
  oldestSequence: number
  highestFence: number
  items: Map<string, AgentJournalRenderItem>
  /** Revision of a removed item, so a late lower revision cannot resurrect it. */
  tombstones: Map<string, number>
  submissions: Map<string, AgentJournalSubmission>
  receipts: Map<string, AgentJournalAcceptanceReceipt>
  /** Provider item id → the submission slot that adopted it. Stops an accepted
   *  echo from appending a second copy of the user's own message. */
  aliases: Map<string, string>
}

export function createJournalReducerState(sessionId: string, epoch: string): JournalReducerState {
  return {
    sessionId,
    epoch,
    lastSequence: 0,
    oldestSequence: 1,
    highestFence: 0,
    items: new Map(),
    tombstones: new Map(),
    submissions: new Map(),
    receipts: new Map(),
    aliases: new Map()
  }
}

export function applyJournalRow(state: JournalReducerState, row: JournalRow): void {
  state.lastSequence = Math.max(state.lastSequence, row.seq)
  state.highestFence = Math.max(state.highestFence, row.fence)
  if (row.kind === 'epoch') {
    return
  }
  if (row.kind === 'item') {
    const itemId = resolveItemId(state, row.itemId)
    upsertItem(state, itemId, row.revision, {
      itemId,
      revision: row.revision,
      body: row.body,
      sequence: row.seq,
      observedAt: row.ts,
      ...(row.recovered ? { recovered: row.recovered } : {})
    })
    return
  }
  if (row.kind === 'tombstone') {
    removeItem(state, resolveItemId(state, row.itemId), row.revision)
    return
  }
  if (row.kind === 'submission') {
    applySubmission(state, row)
    return
  }
  applyDispatch(state, row)
}

function resolveItemId(state: JournalReducerState, itemId: string): string {
  return state.aliases.get(itemId) ?? itemId
}

function upsertItem(
  state: JournalReducerState,
  itemId: string,
  revision: number,
  next: AgentJournalRenderItem
): void {
  const tombstoned = state.tombstones.get(itemId)
  if (tombstoned !== undefined && revision <= tombstoned) {
    return
  }
  const existing = state.items.get(itemId)
  if (existing && revision <= existing.revision) {
    return
  }
  if (!existing) {
    state.items.set(itemId, next)
    state.tombstones.delete(itemId)
    return
  }
  // Creation sequence is the ordering key; a revision refreshes content only.
  state.items.set(itemId, { ...next, sequence: existing.sequence })
  state.tombstones.delete(itemId)
}

function removeItem(state: JournalReducerState, itemId: string, revision: number): void {
  const existing = state.items.get(itemId)
  if (existing && revision <= existing.revision) {
    return
  }
  const tombstoned = state.tombstones.get(itemId)
  if (tombstoned !== undefined && revision <= tombstoned) {
    return
  }
  state.tombstones.set(itemId, revision)
  state.items.delete(itemId)
}

function applySubmission(
  state: JournalReducerState,
  row: Extract<JournalRow, { kind: 'submission' }>
): void {
  state.submissions.set(row.clientMessageId, {
    clientMessageId: row.clientMessageId,
    fence: row.fence,
    payloadFingerprint: row.payloadFingerprint,
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: row.ts,
    resolvedAt: null
  })
  const itemId = agentJournalSubmissionKey(row.clientMessageId)
  upsertItem(state, itemId, 0, {
    itemId,
    revision: 0,
    body: row.body,
    sequence: row.seq,
    observedAt: row.ts
  })
}

function applyDispatch(
  state: JournalReducerState,
  row: Extract<JournalRow, { kind: 'dispatch' }>
): void {
  const submission = state.submissions.get(row.clientMessageId)
  if (!submission) {
    return
  }
  // `rejected` is terminal; a late `unknown` must not reopen a settled answer.
  if (submission.dispatchState === 'rejected' || submission.dispatchState === 'accepted') {
    return
  }
  submission.dispatchState = row.state
  submission.providerItemId = row.providerItemId
  submission.reason = row.reason
  submission.resolvedAt = row.ts
  if (row.state !== 'accepted' || !row.providerItemId) {
    return
  }
  state.aliases.set(row.providerItemId, agentJournalSubmissionKey(row.clientMessageId))
  state.receipts.set(row.clientMessageId, {
    clientMessageId: row.clientMessageId,
    providerItemId: row.providerItemId,
    cursor: { epoch: row.epoch, sequence: row.seq },
    acceptedAt: row.ts
  })
}

/** Project the folded state into the client-facing snapshot. */
export function renderJournalState(state: JournalReducerState): AgentJournalSnapshot {
  // Sequence is the sole ordering key; map insertion order is not, because a
  // re-created item re-enters the map after the items that followed it.
  const items = [...state.items.values()].sort((a, b) => a.sequence - b.sequence)
  return {
    sessionId: state.sessionId,
    cursor: { epoch: state.epoch, sequence: state.lastSequence },
    items,
    submissions: [...state.submissions.values()].sort((a, b) => a.submittedAt - b.submittedAt)
  }
}

/** Digests referenced by live rows, so compaction knows which blobs to keep. */
export function referencedBlobDigests(state: JournalReducerState): Set<string> {
  const digests = new Set<string>()
  for (const item of state.items.values()) {
    for (const digest of referencedBlobDigestsForBody(item.body)) {
      digests.add(digest)
    }
  }
  return digests
}

/** Every structured bounded-payload location supported by the journal. */
export function referencedBlobDigestsForBody(body: AgentJournalItemBody): Set<string> {
  const digests = new Set<string>()
  if (body.kind === 'tool-call' && body.output?.truncated) {
    digests.add(body.output.digest)
  }
  if (body.kind === 'diff' && body.patch.truncated) {
    digests.add(body.patch.digest)
  }
  if (body.kind === 'status' && body.providerFrame?.payload.truncated) {
    digests.add(body.providerFrame.payload.digest)
  }
  return digests
}

/** Digests needed to replay retained raw rows, including superseded revisions. */
export function referencedBlobDigestsForRows(rows: readonly JournalRow[]): Set<string> {
  const digests = new Set<string>()
  for (const row of rows) {
    if (row.kind !== 'item') {
      continue
    }
    for (const digest of referencedBlobDigestsForBody(row.body)) {
      digests.add(digest)
    }
  }
  return digests
}
