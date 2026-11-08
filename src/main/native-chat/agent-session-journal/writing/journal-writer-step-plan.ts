import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readJournalInputItem } from '../input-order/journal-input-obligations'
import { resolveJournalItemId } from '../projection/journal-item-echo'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import { journalItemRowBuilder } from './journal-row-builders'
import type { JournalStepOutcome, JournalWriterStep } from './journal-writer-step'
import { resolveJournalTimelineItem } from './journal-timeline-resolution'
import { journalTimelineView } from './journal-timeline-view'
import { resolveProviderTimelineSettlement } from '../../agent-session-timeline/provider-timeline-writer-resolution'

function lifecycleAppender(state: JournalReducerState): JournalLifecycleBatchAppender {
  return new JournalLifecycleBatchAppender({
    state: () => state,
    cursor: () => ({ epoch: state.epoch, sequence: state.lastSequence }),
    enqueueRows: () => {
      throw new Error('journal step planning cannot enqueue another write')
    }
  })
}

/** null is stale; an empty plan is a valid no-op, including a deduplicated settlement. */
export function planJournalWriterStep(
  state: JournalReducerState,
  step: JournalWriterStep,
  onResolved: (outcome: JournalStepOutcome) => void
): ((seq: number, ts: number) => JournalRow)[] | null {
  if (step.kind === 'resolved-item') {
    const resolved = resolveJournalTimelineItem(
      journalTimelineView(state),
      step.resolution,
      step.options.turnScope,
      step.reservedBytes
    )
    if (resolved.kind === 'dropped') {
      onResolved(resolved)
      return null
    }
    if (resolved.stopped) {
      onResolved({ kind: 'committed', wrote: true, stopped: true })
    }
    return planJournalWriterStep(
      state,
      {
        kind: 'item',
        identity: resolved.item.identity,
        body: resolved.item.body,
        options: { ...step.options, turnScope: resolved.item.turnScope ?? step.options.turnScope },
        reservedBytes: step.reservedBytes
      },
      onResolved
    )
  }
  if (step.kind === 'item') {
    if (
      Buffer.byteLength(JSON.stringify({ identity: step.identity, body: step.body }), 'utf8') +
        512 >
      step.reservedBytes
    ) {
      throw new Error('structured agent-session transition step exceeded its reserved size')
    }
    return [journalItemRowBuilder(() => state, step.identity, step.body, step.options)]
  }
  if (state.appliedSettlementIds.has(step.settlementId)) {
    return []
  }
  const { resolution } = step
  if (resolution.kind !== 'history-catch-up') {
    const mutations = resolveProviderTimelineSettlement(journalTimelineView(state), resolution)
    return lifecycleAppender(state).planResolved({
      settlementId: step.settlementId,
      fence: step.fence,
      ownerFence: step.ownerFence,
      recovered: step.recovered,
      resolve: () => mutations
    })
  }
  if (
    Atomics.load(resolution.permit, 0) !== 1 ||
    Date.now() >= resolution.deadline ||
    state.epoch !== resolution.expectedCursor.epoch ||
    state.lastSequence !== resolution.expectedCursor.sequence
  ) {
    return null
  }
  const bytes =
    Buffer.byteLength(
      JSON.stringify({
        settlementId: step.settlementId,
        mutations: resolution.mutations,
        ...(resolution.expectedItems.length ? { expectedItems: resolution.expectedItems } : {})
      }),
      'utf8'
    ) + 512
  if (bytes > step.reservedBytes) {
    throw new Error('structured agent-session transition step exceeded its reserved size')
  }
  const verified = new Set<string>()
  for (const expected of resolution.expectedItems) {
    const canonical = resolveJournalItemId(state, expected.key)
    if (
      verified.has(expected.key) ||
      canonical !== expected.canonicalItemId ||
      readJournalInputItem(state, canonical)?.revision !== expected.revision
    ) {
      return null
    }
    verified.add(expected.key)
  }
  const seen = new Set<string>()
  for (const mutation of resolution.mutations) {
    const key = agentJournalItemKey(mutation.identity)
    const canonical = resolveJournalItemId(state, key)
    if (seen.has(canonical) || (!verified.has(key) && readJournalInputItem(state, canonical))) {
      return null
    }
    seen.add(canonical)
  }
  return lifecycleAppender(state).plan({
    settlementId: step.settlementId,
    fence: step.fence,
    ownerFence: step.ownerFence,
    recovered: step.recovered,
    mutations: resolution.mutations
  })
}
