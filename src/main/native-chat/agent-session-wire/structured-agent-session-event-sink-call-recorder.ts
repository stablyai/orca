// A provider event sink for tests that names every call a provider makes on it, in order: which
// frames reach the host only as a noted frame, and nothing else.

import { vi } from 'vitest'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'

export function recordingEventSink(): {
  sink: StructuredAgentSessionEventSink
  /** Every method called so far, by name. */
  calls: string[]
} {
  const calls: string[] = []
  const accepted = { accepted: true } as const
  const call =
    <T>(name: string, result: T) =>
    () => {
      calls.push(name)
      return result
    }
  const sink: Required<StructuredAgentSessionEventSink> = {
    appendItem: vi.fn(call('appendItem', undefined)),
    appendTombstone: vi.fn(call('appendTombstone', undefined)),
    tryAppendTombstone: vi.fn(call('tryAppendTombstone', accepted)),
    publish: vi.fn(call('publish', undefined)),
    setActivity: vi.fn(call('setActivity', undefined)),
    tryAppendItem: vi.fn(call('tryAppendItem', accepted)),
    tryAppendResolvedItem: vi.fn(call('tryAppendResolvedItem', accepted)),
    tryAppendResolvedItemAndPublish: vi.fn(call('tryAppendResolvedItemAndPublish', accepted)),
    tryReviseResolvedItem: vi.fn(call('tryReviseResolvedItem', accepted)),
    tryReviseResolvedItemAndPublish: vi.fn(call('tryReviseResolvedItemAndPublish', accepted)),
    tryAppendLifecycleTransition: vi.fn(call('tryAppendLifecycleTransition', accepted)),
    journalEpoch: vi.fn(call('journalEpoch', null)),
    journalLinkage: vi.fn(call('journalLinkage', null)),
    journalStopDecidesTurn: vi.fn(call('journalStopDecidesTurn', false)),
    appendLifecycleBatch: vi.fn(call('appendLifecycleBatch', accepted)),
    tryAppendLifecycleBatch: vi.fn(call('tryAppendLifecycleBatch', accepted)),
    tryPublish: vi.fn(call('tryPublish', accepted)),
    bindReadingControl: vi.fn(call('bindReadingControl', () => undefined)),
    noteProviderFrame: vi.fn(call('noteProviderFrame', undefined))
  }
  return { sink, calls }
}
