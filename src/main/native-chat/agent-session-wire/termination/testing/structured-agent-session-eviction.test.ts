import { describe, expect, it } from 'vitest'
import { evictStructuredAgentSession } from '../structured-agent-session-eviction'
import { StructuredAgentSessionHostRuntimeState } from '../../host/structured-agent-session-host-runtime-state'
import { withJournalQueueMembers } from '../../journal-ingress/testing/structured-agent-session-journal-double-test-support'
import { recordingStructuredAgentSessionLogger } from '../../host/testing/structured-agent-session-logger-test-support'

function runtimeState(): StructuredAgentSessionHostRuntimeState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: eviction against the sink cache reads only the sinks and the logger; store and adapter are never reached.
  const deps = {
    store: {},
    adapter: {},
    logger: recordingStructuredAgentSessionLogger().logger
  } as never
  return new StructuredAgentSessionHostRuntimeState(deps, new Map())
}

// Cached sinks must be discarded after close so reopened chats can publish through fresh sinks.
describe('eviction against the real sink cache', () => {
  it('lets the session publish again after it is evicted and reattached', async () => {
    const state = runtimeState()
    const sessionId = 'session-reattach'
    await evictStructuredAgentSession({
      sessionId,
      logger: recordingStructuredAgentSessionLogger().logger,
      eventSink: state.eventSinkFor(sessionId),
      discardSink: () => state.discardEventSink(sessionId),
      acknowledgeRelease: () => {}
    })

    const published: string[] = []
    const reattached = state.eventSinkFor(sessionId)
    reattached.bind({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these rows are publications only, which reach nothing on the journal but its in-order read.
      journal: withJournalQueueMembers({ appendItem: async () => ({}) }) as never,
      fence: 2,
      publish: () => published.push('published')
    })
    reattached.sink.publish()
    await reattached.drained()

    expect(published).toEqual(['published'])
  })
})
