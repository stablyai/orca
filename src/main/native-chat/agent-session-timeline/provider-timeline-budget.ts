// Items, requests and streams share one admission budget. Recheck journal settlement before refusing;
// exhaustion fails the session so dead-generation recovery can settle retained work.

import type { StructuredAgentSessionSinkAdmission } from '../agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import type { ProviderTimelineState } from './provider-timeline-state'
import type { ProviderTimelineTextStreams } from './provider-timeline-text-streams'

export const MAX_PROVIDER_TIMELINE_OPEN_ENTRIES = 128
export const MAX_PROVIDER_TIMELINE_OPEN_BYTES = 1024 * 1024

export const PROVIDER_TIMELINE_OVER_BUDGET: StructuredAgentSessionSinkAdmission = {
  accepted: false,
  reason: 'failed'
}

export type ProviderTimelineHold = { key: string; bytes: number }

export function providerTimelineBudgetAdmits(input: {
  hold: ProviderTimelineHold
  state: ProviderTimelineState
  streams: ProviderTimelineTextStreams
  journal: StructuredAgentSessionTransitionJournal | null
}): boolean {
  if (fits(input)) {
    return true
  }
  const { journal, state, streams } = input
  if (!journal) {
    return false
  }
  for (const key of state.items.keys()) {
    if (state.settledInJournal(key, journal)) {
      state.items.delete(key)
    }
  }
  streams.stopSettled(journal)
  return fits(input)
}

function fits(input: {
  hold: ProviderTimelineHold
  state: ProviderTimelineState
  streams: ProviderTimelineTextStreams
}): boolean {
  const open = new Map<string, number>()
  for (const [key, entry] of input.state.items) {
    if (!entry.closed) {
      open.set(key, entry.bytes)
    }
  }
  for (const stream of input.streams.open) {
    open.set(stream.key, Math.max(open.get(stream.key) ?? 0, stream.bytes))
  }
  open.set(input.hold.key, Math.max(open.get(input.hold.key) ?? 0, input.hold.bytes))
  let bytes = 0
  for (const each of open.values()) {
    bytes += each
  }
  return (
    open.size <= MAX_PROVIDER_TIMELINE_OPEN_ENTRIES && bytes <= MAX_PROVIDER_TIMELINE_OPEN_BYTES
  )
}
