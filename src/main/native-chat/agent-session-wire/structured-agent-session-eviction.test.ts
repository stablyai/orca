import { describe, expect, it, vi } from 'vitest'
import {
  evictStructuredAgentSession,
  StructuredAgentSessionEvictionError,
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS,
  type StructuredAgentSessionEvictionContext
} from './structured-agent-session-eviction'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { withJournalQueueMembers } from './structured-agent-session-journal-double-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

function context(closeError?: Error): StructuredAgentSessionEvictionContext & { order: string[] } {
  const order: string[] = []
  return {
    order,
    sessionId: 'session-1',
    logger: createStructuredAgentSessionLogger(),
    eventSink: {
      unbind: vi.fn(() => order.push('unbind')),
      drained: vi.fn(async () => {
        order.push('drained')
        return { ok: true as const }
      }),
      close: vi.fn(() => {
        order.push('close')
        if (closeError) {
          throw closeError
        }
      })
    },
    acknowledgeRelease: vi.fn(() => {
      order.push('acknowledgeRelease')
    }),
    discardSink: vi.fn(() => order.push('discardSink'))
  }
}

function runtimeState(): StructuredAgentSessionHostRuntimeState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: eviction against the sink cache reads only the sinks and the logger; store and adapter are never reached.
  return new StructuredAgentSessionHostRuntimeState({
    store: {},
    adapter: {},
    logger: recordingStructuredAgentSessionLogger().logger
  } as never)
}

describe("the route release after a child's exit", () => {
  it('lets the sink go before it acknowledges the release', async () => {
    const ctx = context()
    await evictStructuredAgentSession(ctx)
    expect(ctx.order).toEqual(['unbind', 'close', 'discardSink', 'acknowledgeRelease'])
  })

  it('names every step, so a failure says which one it was', () => {
    expect(STRUCTURED_AGENT_SESSION_EVICTION_STEPS.map((step) => step.name)).toEqual([
      'stop-publishing',
      'close-sink',
      'discard-sink',
      'acknowledge-release'
    ])
  })

  // Bookkeeping for a process already gone: none of it may keep the child on record.
  it('reports a failed step with its name and still runs every step after it', async () => {
    const recorded = recordingStructuredAgentSessionLogger()
    const ctx = { ...context(new Error('sink already gone')), logger: recorded.logger }

    await expect(evictStructuredAgentSession(ctx)).resolves.toBeUndefined()

    expect(ctx.order).toEqual(['unbind', 'close', 'discardSink', 'acknowledgeRelease'])
    expect(recorded.entries.map((entry) => entry.fields.error)).toEqual([
      expect.objectContaining({ step: 'close-sink' })
    ])
    expect(recorded.entries[0]?.fields.error).toBeInstanceOf(StructuredAgentSessionEvictionError)
  })
})

// The runtime caches ONE sink per session id and hands the same instance to the next attach, so an
// eviction that closes without discarding leaves a reopened chat wired to a permanently closed
// sink — it accepts every provider event and publishes none.
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
