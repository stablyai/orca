import { describe, expect, it, vi } from 'vitest'
import {
  evictStructuredAgentSession,
  StructuredAgentSessionEvictionError,
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS,
  type StructuredAgentSessionEvictionContext
} from './structured-agent-session-eviction'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionPreSpawnError
} from './structured-agent-session-adapter'
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
        return { ok: true }
      }),
      close: vi.fn(() => order.push('close'))
    } as unknown as StructuredAgentSessionEvictionContext['eventSink'],
    adapter: {
      closeSession: vi.fn(async () => {
        order.push('closeSession')
        return true
      })
    } as unknown as StructuredAgentSessionEvictionContext['adapter'],
    acknowledgeRelease: vi.fn(() => {
      order.push('acknowledgeRelease')
    }),
    discardSink: vi.fn(() => order.push('discardSink')),
    settleWork: vi.fn(async () => {
      order.push('settleWork')
    }),
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
  it('stops the child before it lets the sink go, then acknowledges the release', async () => {
    const ctx = context()
    await evictStructuredAgentSession(ctx)
    expect(ctx.order).toEqual([
      'closeSession',
      'drained',
      'settleWork',
      'unbind',
      'close',
      'discardSink',
      'releaseLease',
      'acknowledgeRelease'
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
      'snapshot-before-stop',
      'stop-provider-child',
      'drain-published',
      'settle-dead-generation',
      'stop-publishing',
      'close-sink',
      'discard-sink',
      'release-lease',
      'acknowledge-release'
    ])
  })

  it('still stops the child when the pre-stop snapshot cannot drain the sink', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const ctx = context()
      const snapshot = vi.fn()
      ctx.beforeProviderChildStop = snapshot
      // A journal write that never settles, then a healthy sink once the child is stopped.
      vi.mocked(ctx.eventSink.drained).mockReturnValueOnce(new Promise<never>(() => {}))

      const eviction = evictStructuredAgentSession(ctx)
      await vi.advanceTimersByTimeAsync(1_000)

      expect(snapshot).toHaveBeenCalledOnce()
      expect(ctx.adapter.closeSession).toHaveBeenCalledOnce()
      await eviction
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a failed drain barrier and still winds the child down', async () => {
    const ctx = context()
    const reported = vi.fn()
    ctx.onBestEffortStepFailure = reported
    ctx.eventSink.drained = vi.fn(async () => {
      ctx.order.push('drained')
      return { ok: false, error: new Error('append failed') }
    }) as unknown as StructuredAgentSessionEvictionContext['eventSink']['drained']

    await evictStructuredAgentSession(ctx)

    expect(reported).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'drain-published', sessionId: 'session-1' })
    )
    expect(ctx.order).toEqual([
      'closeSession',
      'drained',
      'settleWork',
      'unbind',
      'close',
      'discardSink',
      'releaseLease',
      'acknowledgeRelease'
    ])
  })

  it('reports a failed settlement and still hands the lease back', async () => {
    const ctx = context()
    const reported = vi.fn()
    ctx.onBestEffortStepFailure = reported
    ctx.settleWork = vi.fn(async () => {
      throw new Error('journal write failed')
    })

    await evictStructuredAgentSession(ctx)

    expect(reported).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'settle-dead-generation' })
    )
    expect(ctx.releaseLease).toHaveBeenCalledOnce()
    expect(ctx.acknowledgeRelease).toHaveBeenCalledOnce()
  })

  it('aborts at a release that cannot be written, before the adapter drops the route', async () => {
    const ctx = context()
    ctx.releaseLease = vi.fn(async () => {
      throw new Error('store write failed')
    })

    await expect(evictStructuredAgentSession(ctx)).rejects.toMatchObject({
      step: 'release-lease'
    })
    expect(ctx.acknowledgeRelease).not.toHaveBeenCalled()
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
      discardSink: () => state.discardEventSink(sessionId),
      releaseLease: async () => {},
      acknowledgeRelease: () => {}
    })

    expect(published).toEqual(['final-flush'])
  })
})

// `closeSession` returning false means the adapter could not prove the child exited. The child is
// closing either way, so the host stops claiming it and only the lease hears the verdict.
describe('a child that will not stop', () => {
  it.each([
    new AgentSessionAcquisitionRootExitObservedError(new Error('root exited')),
    new AgentSessionPreSpawnError(new Error('spawn failed'))
  ])('continues eviction after an actionable provider verdict', async (error) => {
    const ctx = context()
    ctx.adapter.closeSession = vi.fn(async () => {
      throw error
    })
    const stopped = vi.fn()
    ctx.onProviderChildStopped = stopped

    await evictStructuredAgentSession(ctx)

    // The host ends its child on the one reading of the verdict, not a second one of its own.
    expect(stopped).toHaveBeenCalledWith({ rootGone: true })
    expect(ctx.order).toEqual([
      'drained',
      'settleWork',
      'unbind',
      'close',
      'discardSink',
      'releaseLease',
      'acknowledgeRelease'
    ])
  })

  it.each([
    ['answers false', async () => false],
    [
      'throws an unproven exit',
      async () => {
        throw new AgentSessionAcquisitionExitUnprovenError(new Error('tree still running'))
      }
    ]
  ])('winds the child down with an unproven verdict when its close %s', async (_how, close) => {
    const ctx = context()
    ctx.adapter.closeSession = vi.fn(close)
    const stopped = vi.fn()
    ctx.onProviderChildStopped = stopped

    await evictStructuredAgentSession(ctx)

    expect(stopped).toHaveBeenCalledWith({ rootGone: false })
    expect(ctx.order).toEqual([
      'drained',
      'settleWork',
      'unbind',
      'close',
      'discardSink',
      'releaseLease',
      'acknowledgeRelease'
    ])
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
    expect(ctx.acknowledgeRelease).not.toHaveBeenCalled()
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
      discardSink: () => state.discardEventSink(sessionId),
      releaseLease: async () => {},
      acknowledgeRelease: () => {}
    })

    const published: string[] = []
    const reattached = state.eventSinkFor(sessionId)
    reattached.bind({ journal: {} as never, fence: 2, publish: () => published.push('published') })
    reattached.sink.publish()
    await reattached.drained()

    expect(published).toEqual(['published'])
  })
})
