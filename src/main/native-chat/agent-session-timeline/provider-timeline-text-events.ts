import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { ProviderTimelineDropRule } from './provider-timeline-decision'
import type { ProviderTimelineEvent } from './provider-timeline-event'
import { ProviderTimelinePlan, type ProviderTimelineSink } from './provider-timeline-plan'
import { turnOf } from './provider-timeline-rows'
import type { ProviderTimelineState } from './provider-timeline-state'
import type { ProviderTimelineTextStreams } from './provider-timeline-text-streams'

export type ProviderTimelineApplyResult = {
  /** Refused admission changes nothing. */
  admission: StructuredAgentSessionSinkAdmission
  dropped?: ProviderTimelineDropRule
}

export type ProviderTimelineTextHost = {
  sink: ProviderTimelineSink
  state: ProviderTimelineState
  streams: ProviderTimelineTextStreams
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
    // Flush the previous anonymous message before beginning another.
    streams.planFlush(plan)
    const ended = stream
    streams.planRelease(plan, (each) => each === ended)
    stream = undefined
  }
  if (!stream) {
    if (streams.stoppedFor(key, event.join)) {
      return { admission: ADMITTED, dropped: 'turn-settled' }
    }
    // The writer refuses text for a settled turn; this producer's own closes need no journal read.
    if ('id' in event.item && state.closedItems.has(key)) {
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
    plan.onAdmitted(serials.commit)
  }
  streams.planAppend(plan, stream, event.text)
  return { admission: plan.submit(host.sink) }
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
    // Text close also settles full-snapshot writes for this item.
    plan.onAdmitted(() => state.close(stream.key, turnOf(stream.scope)))
  }
  return { admission: plan.submit(host.sink) }
}
