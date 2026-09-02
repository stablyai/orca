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
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import type { JournalRow } from './journal-row-schema'

export const MAX_JOURNAL_APPLIED_SETTLEMENT_IDS = 4_096

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
  appliedSettlementIds: Set<string>
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
    aliases: new Map(),
    appliedSettlementIds: new Set()
  }
}

export function applyJournalRow(state: JournalReducerState, row: JournalRow): void {
  state.lastSequence = Math.max(state.lastSequence, row.seq)
  state.highestFence = Math.max(state.highestFence, row.fence)
  if (row.kind === 'epoch') {
    return
  }
  if (row.kind === 'item') {
    const itemId = resolveJournalItemId(state, row.itemId, row.body)
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
  if (row.kind === 'lifecycle-batch') {
    if (state.appliedSettlementIds.has(row.settlementId)) {
      return
    }
    for (const mutation of row.mutations) {
      if (mutation.kind === 'item') {
        const itemId = resolveJournalItemId(state, mutation.itemId, mutation.body)
        upsertItem(state, itemId, mutation.revision, {
          itemId,
          revision: mutation.revision,
          body: mutation.body,
          sequence: row.seq,
          observedAt: row.ts,
          ...(row.recovered ? { recovered: row.recovered } : {})
        })
      } else {
        removeItem(state, resolveItemId(state, mutation.itemId), mutation.revision)
      }
    }
    rememberAppliedSettlementId(state, row.settlementId)
    return
  }
  if (row.kind === 'submission') {
    applySubmission(state, row)
    return
  }
  applyDispatch(state, row)
}

export function rememberAppliedSettlementId(
  state: JournalReducerState,
  settlementId: string
): void {
  state.appliedSettlementIds.add(settlementId)
  while (state.appliedSettlementIds.size > MAX_JOURNAL_APPLIED_SETTLEMENT_IDS) {
    const oldest = state.appliedSettlementIds.values().next().value
    if (oldest === undefined) {
      return
    }
    state.appliedSettlementIds.delete(oldest)
  }
}

export function resolveJournalItemId(
  state: JournalReducerState,
  itemId: string,
  body?: AgentJournalRenderItem['body']
): string {
  const aliased = state.aliases.get(itemId)
  if (aliased) {
    return aliased
  }
  const identity = parseAgentJournalItemKey(itemId)
  if (
    !body ||
    body.kind !== 'message' ||
    body.role !== 'user' ||
    !identity ||
    identity.provider === 'orca'
  ) {
    return itemId
  }
  const fingerprint = structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: state.sessionId,
    fields: { body }
  })
  // Exact payload plus queue order preserves repeated identical sends one-for-one.
  const submission = [...state.submissions.values()]
    .sort((left, right) => left.submittedAt - right.submittedAt)
    .find((candidate) => {
      if (candidate.dispatchState === 'rejected' || candidate.payloadFingerprint !== fingerprint) {
        return false
      }
      return state.items.get(agentJournalSubmissionKey(candidate.clientMessageId))?.revision === 0
    })
  if (!submission) {
    return itemId
  }
  const submissionId = agentJournalSubmissionKey(submission.clientMessageId)
  state.aliases.set(itemId, submissionId)
  return submissionId
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
  // `observedAt` is pinned with it: clients sort the timeline by that timestamp,
  // so letting a revision advance it makes the row jump past everything that
  // landed in between — the provider's own echo of a send revises the submission
  // row, which relocated the user's bubble below later rows.
  state.items.set(itemId, { ...next, sequence: existing.sequence, observedAt: existing.observedAt })
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

/** Blob digests one body points at. A retained row can outlive its render item
 *  (a tombstone drops the item), so compaction reads rows through this too. */
export function blobDigestsInBody(body: AgentJournalItemBody, into: Set<string>): void {
  if (body.kind === 'tool-call' && body.output?.truncated) {
    into.add(body.output.digest)
  }
  if (body.kind === 'diff' && body.patch.truncated) {
    into.add(body.patch.digest)
  }
  if (body.kind === 'status' && body.providerFrame?.payload.truncated) {
    into.add(body.providerFrame.payload.digest)
  }
}

/** Digests referenced by live rows, so compaction knows which blobs to keep. */
export function referencedBlobDigests(state: JournalReducerState): Set<string> {
  const digests = new Set<string>()
  for (const item of state.items.values()) {
    blobDigestsInBody(item.body, digests)
  }
  return digests
}
