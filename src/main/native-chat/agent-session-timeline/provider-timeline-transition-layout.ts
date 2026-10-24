import {
  providerTimelineSettlementId,
  type ProviderTimelineContext
} from './provider-timeline-context'
import type {
  ProviderTimelineDecidedEvent,
  ProviderTimelineDecision
} from './provider-timeline-decision'
import type { ProviderTimelinePlan } from './provider-timeline-plan'
import { turnOf } from './provider-timeline-rows'
import type { ProviderTimelineState } from './provider-timeline-state'
import type { ProviderTimelineTextStreams } from './provider-timeline-text-streams'

/** Pace admission; actual settlement mutations resolve from the journal. */
const SETTLEMENT_RESERVED_BYTES = 64 * 1024

/** Flush preceding text; separate anonymous messages by producer and release streams at their own boundaries. */
export function planProviderTimelineBarrier(
  input: {
    streams: ProviderTimelineTextStreams
    state: ProviderTimelineState
  },
  plan: ProviderTimelinePlan,
  event: ProviderTimelineDecidedEvent,
  decision: ProviderTimelineDecision
): void {
  const { streams, state } = input
  // Full snapshots supersede deltas for the same row; do not flush stale text.
  const replaced = decision.closes ? streams.get(decision.closes) : undefined
  streams.planFlush(plan, replaced)
  if (replaced) {
    streams.planRelease(plan, (stream) => stream === replaced)
  }
  if (event.type === 'session.ended') {
    streams.planRelease(plan, () => true)
    return
  }
  if (event.type === 'turn.end' || event.type === 'turn.open' || event.type === 'turn.settled') {
    const ending =
      decision.ends?.turnItemId ?? (event.type === 'turn.open' ? state.open?.itemId : undefined)
    const current = event.type === 'turn.open' || decision.ends?.current === true
    if (event.type === 'turn.settled') {
      streams.planStop(plan, event.turn.itemId)
    } else if (event.type === 'turn.open') {
      streams.planBoundary(plan, null)
    } else if (ending !== undefined) {
      streams.planBoundary(plan, ending)
    }
    streams.planRelease(
      plan,
      (stream) =>
        (current && !stream.named && stream.producer?.agentId === undefined) ||
        (ending !== undefined && turnOf(stream.scope) === ending)
    )
    return
  }
  if (event.type !== 'input.accepted') {
    const agentId = 'producer' in event ? event.producer?.agentId : undefined
    streams.planRelease(plan, (stream) => !stream.named && stream.producer?.agentId === agentId)
  }
}

export function planProviderTimelineWrites(
  context: ProviderTimelineContext,
  plan: ProviderTimelinePlan,
  decision: ProviderTimelineDecision,
  serial: () => number
): void {
  const { settle } = decision
  if (settle) {
    plan.settlement({
      settlementId: providerTimelineSettlementId(context, serial(), settle.what),
      reservedBytes: SETTLEMENT_RESERVED_BYTES,
      recovered: settle.recovered,
      resolve: settle.resolve
    })
  }
  for (const write of decision.writes ?? []) {
    plan.item(
      {
        reservedBytes: write.reservedBytes,
        resolve: write.resolve,
        options: write.options
      },
      write.lifecycle
    )
  }
}
