import { describe, expect, it, vi } from 'vitest'
import {
  evictStructuredAgentSession,
  StructuredAgentSessionEvictionError,
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS,
  type StructuredAgentSessionEvictionContext
} from './structured-agent-session-eviction'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'

function context(): StructuredAgentSessionEvictionContext & { order: string[] } {
  const order: string[] = []
  return {
    order,
    sessionId: 'session-1',
    eventSink: {
      unbind: vi.fn(() => order.push('unbind')),
      drained: vi.fn(async () => {
        order.push('drained')
      }),
      close: vi.fn(() => order.push('close'))
    } as unknown as StructuredAgentSessionEvictionContext['eventSink'],
    adapter: {
      closeSession: vi.fn(async () => {
        order.push('closeSession')
        return true
      })
    } as unknown as StructuredAgentSessionEvictionContext['adapter'],
    forget: vi.fn(() => order.push('forget')),
    discardSink: vi.fn(() => order.push('discardSink')),
    releaseLease: vi.fn(async () => {
      order.push('releaseLease')
    })
  }
}

function runtimeState(): StructuredAgentSessionHostRuntimeState {
  return new StructuredAgentSessionHostRuntimeState({
    store: {} as never,
    adapter: {} as never
  } as never)
}

describe('structured agent session eviction', () => {
  it('stops the child before it lets the sink go, then forgets the session', async () => {
    const ctx = context()
    await evictStructuredAgentSession(ctx)
    expect(ctx.order).toEqual([
      'closeSession',
      'drained',
      'unbind',
      'close',
      'discardSink',
      'releaseLease',
      'forget'
    ])
  })

  it('uses disposal rather than handoff close when the chat is removed', async () => {
    const ctx = context()
    const closeSession = vi.fn(async () => {
      throw new Error('resume cursor unavailable')
    })
    const disposeSession = vi.fn(async () => true)
    ctx.adapter = { ...ctx.adapter, closeSession, disposeSession }

    await evictStructuredAgentSession(ctx)

    expect(disposeSession).toHaveBeenCalledWith('session-1')
    expect(closeSession).not.toHaveBeenCalled()
  })

  it('names every step, so a half-finished eviction says which one failed', () => {
    expect(STRUCTURED_AGENT_SESSION_EVICTION_STEPS.map((step) => step.name)).toEqual([
      'stop-provider-child',
      'drain-published',
      'stop-publishing',
      'close-sink',
      'discard-sink',
      'release-lease',
      'forget-session'
    ])
  })
})

// Closing the codex child is not silent: the adapter emits its `ended` event and flushes coalesced
// text as it shuts down, and those rows are what clear the running-turn marker. If the sink is
// already closed the journal keeps claiming the agent is working, forever.
describe('rows the provider emits while closing', () => {
  it('still reach the journal', async () => {
    const state = runtimeState()
    const sessionId = 'session-closing-rows'
    const sink = state.eventSinkFor(sessionId)
    const published: string[] = []
    sink.bind({ journal: {} as never, fence: 1, publish: () => published.push('final-flush') })

    await evictStructuredAgentSession({
      sessionId,
      eventSink: sink,
      adapter: {
        closeSession: async () => {
          // What codex-structured-session-close does on its way out.
          sink.sink.publish()
          return true
        }
      } as never,
      forget: () => {},
      discardSink: () => state.discardEventSink(sessionId),
      releaseLease: async () => {}
    })

    expect(published).toEqual(['final-flush'])
  })
})

// `closeSession` returning false means the adapter could not prove the child exited and has kept
// the session indexed on purpose so a retry can reach it.
describe('a child that will not stop', () => {
  it('aborts without forgetting the session, so the next close is a real retry', async () => {
    const ctx = context()
    ctx.adapter.closeSession = vi.fn(async () => false)

    await expect(evictStructuredAgentSession(ctx)).rejects.toMatchObject({
      step: 'stop-provider-child'
    })
    expect(ctx.forget).not.toHaveBeenCalled()
    expect(ctx.discardSink).not.toHaveBeenCalled()
    expect(ctx.order).toEqual([])
  })

  it('reports the failing step and leaves the sink usable for the retry', async () => {
    const ctx = context()
    ctx.adapter.closeSession = vi.fn(async () => {
      throw new Error('child would not stop')
    })

    await expect(evictStructuredAgentSession(ctx)).rejects.toBeInstanceOf(
      StructuredAgentSessionEvictionError
    )
    expect(ctx.eventSink.close).not.toHaveBeenCalled()
    expect(ctx.forget).not.toHaveBeenCalled()
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
      eventSink: state.eventSinkFor(sessionId),
      adapter: { closeSession: async () => true } as never,
      forget: () => {},
      discardSink: () => state.discardEventSink(sessionId),
      releaseLease: async () => {}
    })

    const published: string[] = []
    const reattached = state.eventSinkFor(sessionId)
    reattached.bind({ journal: {} as never, fence: 2, publish: () => published.push('published') })
    reattached.sink.publish()
    await reattached.drained()

    expect(published).toEqual(['published'])
  })
})
