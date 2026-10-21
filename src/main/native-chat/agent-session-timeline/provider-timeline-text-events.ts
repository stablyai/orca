// Text events: streams admitted like every other event.

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import type { ProviderTimelineHold } from './provider-timeline-budget'
import { PROVIDER_TIMELINE_OVER_BUDGET } from './provider-timeline-budget'
import type { ProviderTimelineDropRule } from './provider-timeline-decision'
import type { ProviderTimelineEvent } from './provider-timeline-event'
import { ProviderTimelinePlan, type ProviderTimelineSink } from './provider-timeline-plan'
import { providerTimelineTurnRowState, turnOf } from './provider-timeline-rows'
import type { ProviderTimelineState } from './provider-timeline-state'
import type { ProviderTimelineTextStreams } from './provider-timeline-text-streams'

export type ProviderTimelineApplyResult = {
  /** The sink's answer for the event's writes; refused means nothing changed. */
  admission: StructuredAgentSessionSinkAdmission
  dropped?: ProviderTimelineDropRule
}

/** What the text appliers share with the assembler that owns them. */
export type ProviderTimelineTextHost = {
  sink: ProviderTimelineSink
  state: ProviderTimelineState
  streams: ProviderTimelineTextStreams
  journal: StructuredAgentSessionTransitionJournal | null
  admits(hold: ProviderTimelineHold): boolean
}

const ADMITTED: StructuredAgentSessionSinkAdmission = { accepted: true }

export function applyProviderTimelineTextDelta(
  host: ProviderTimelineTextHost,
  event: Extract<ProviderTimelineEvent, { type: 'text.delta' }>
): ProviderTimelineApplyResult {
  const { streams, state } = host
  if (state.ended) {
    return { admission: ADMITTED, dropped: 'session-ended' }
  }
  const plan = new ProviderTimelinePlan()
  const key = streams.key(event.item, event.join)
  let stream = streams.get(key)
  if (stream && !streams.continues(stream, event.channel, event.producer)) {
    if (stream.named) {
      return { admission: ADMITTED, dropped: 'stream-mismatch' }
    }
    // The anonymous stream's next message: what the last one owes lands first.
    streams.planFlush(plan)
    const ended = stream
    streams.planRelease(plan, (each) => each === ended)
    stream = undefined
  }
  if (!stream) {
    if (streams.stoppedFor(key, event.join)) {
      return { admission: ADMITTED, dropped: 'turn-settled' }
    }
    if ('id' in event.item && settledNamedItem(host, key)) {
      return { admission: ADMITTED, dropped: 'item-settled' }
    }
    const serials = state.serials()
    stream = streams.start({
      item: event.item,
      join: event.join,
      channel: event.channel,
      producer: event.producer,
      state,
      serial: serials.next()
    })
    if (!host.admits({ key: stream.key, bytes: stream.bytes })) {
      return { admission: PROVIDER_TIMELINE_OVER_BUDGET }
    }
    plan.onAdmitted(serials.commit)
  }
  streams.planAppend(plan, stream, event.text)
  return { admission: plan.submit(host.sink) }
}

/** A named delta for an item this run closed, or one the journal holds in a settled turn. */
function settledNamedItem(host: ProviderTimelineTextHost, key: string): boolean {
  if (host.state.items.get(key)?.closed) {
    return true
  }
  const held = host.journal?.item(key)
  const turn = held ? turnOf(held.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE) : null
  return (
    host.journal !== null &&
    turn !== null &&
    providerTimelineTurnRowState(host.journal, turn) === 'settled'
  )
}

export function applyProviderTimelineTextClose(
  host: ProviderTimelineTextHost,
  event: Extract<ProviderTimelineEvent, { type: 'text.close' }>
): ProviderTimelineApplyResult {
  const { streams, state } = host
  if (state.ended) {
    return { admission: ADMITTED, dropped: 'session-ended' }
  }
  const key = streams.key(event.item, event.join)
  const stream = streams.get(key)
  if (!stream) {
    return {
      admission: ADMITTED,
      dropped: streams.stoppedFor(key, event.join) ? 'turn-settled' : 'stream-unknown'
    }
  }
  const plan = new ProviderTimelinePlan()
  streams.planFlush(plan, stream)
  streams.planClose(plan, stream, event.text)
  if (stream.named) {
    // The close settles the item for full snapshots too.
    plan.onAdmitted(() => state.close(stream.key, turnOf(stream.scope)))
  }
  return { admission: plan.submit(host.sink) }
}
