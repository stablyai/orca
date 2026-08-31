// The parts a session's lifetime is assembled from: the holder set, the release clock, and the
// deadline that keeps teardown from hanging.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { StructuredAgentSessionReleaseClock } from './structured-agent-session-release-clock'
import { StructuredAgentSessionHolds } from './structured-agent-session-holds'
import {
  STRUCTURED_AGENT_SESSION_EVICTION_STEPS,
  evictStructuredAgentSession
} from './structured-agent-session-eviction'
import {
  StructuredAgentSessionEvictionTimeoutError,
  withStructuredAgentSessionEvictionDeadline
} from './structured-agent-session-eviction-deadline'

const clocks: StructuredAgentSessionReleaseClock[] = []

function clock(deps: {
  isTurnActive?: () => boolean
  isHeld?: () => boolean
  evict: (sessionId: string) => Promise<void>
  onError?: (input: { sessionId: string; error: unknown }) => void
}): StructuredAgentSessionReleaseClock {
  const created = new StructuredAgentSessionReleaseClock({
    isTurnActive: deps.isTurnActive ?? (() => false),
    isHeld: deps.isHeld ?? (() => false),
    evict: deps.evict,
    ...(deps.onError ? { onError: deps.onError } : {}),
    graceMs: 1
  })
  clocks.push(created)
  return created
}

afterEach(() => {
  for (const created of clocks.splice(0)) {
    created.dispose()
  }
})

describe('the release clock', () => {
  it('waits out a running turn instead of evicting into it', async () => {
    const evict = vi.fn(async () => {})
    let turnRunning = true
    const releasing = clock({ isTurnActive: () => turnRunning, evict })

    releasing.arm('session-1')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(evict).not.toHaveBeenCalled()

    turnRunning = false
    await vi.waitFor(() => expect(evict).toHaveBeenCalledWith('session-1'))
  })

  it('stands down when a holder arrives during the wait', async () => {
    const evict = vi.fn(async () => {})
    const releasing = clock({ isHeld: () => true, evict })

    releasing.arm('session-1')
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(evict).not.toHaveBeenCalled()
  })

  it('reports a failed eviction rather than swallowing it', async () => {
    const onError = vi.fn()
    const releasing = clock({
      evict: async () => {
        throw new Error('child would not stop')
      },
      onError
    })

    releasing.arm('session-1')

    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith({
        sessionId: 'session-1',
        error: expect.objectContaining({ message: 'child would not stop' })
      })
    )
  })
})

describe('holds', () => {
  it('resumes a session on its first hold and not on a retained one', async () => {
    let child = false
    const resume = vi.fn(async () => {
      child = true
    })
    const holds = new StructuredAgentSessionHolds({
      resume,
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict: async () => {},
      graceMs: 1
    })

    await holds.hold('session-1', 'stream-1', { resume: false })
    expect(resume).not.toHaveBeenCalled()

    await holds.hold('session-1', 'chat-1')
    expect(resume).toHaveBeenCalledOnce()

    child = true
    await holds.hold('session-1', 'chat-2')
    expect(resume).toHaveBeenCalledOnce()
    holds.dispose()
  })

  it('never arms the clock for a session with nothing to stop', async () => {
    const evict = vi.fn(async () => {})
    const holds = new StructuredAgentSessionHolds({
      resume: async () => {},
      hasProviderChild: () => false,
      isTurnActive: () => false,
      evict,
      graceMs: 1
    })

    await holds.hold('session-1', 'chat-1', { resume: false })
    holds.release('session-1', 'chat-1')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(evict).not.toHaveBeenCalled()
    expect(holds.isReleasePending('session-1')).toBe(false)
    holds.dispose()
  })

  it('fails a write-capable hold when resume proves no provider child', async () => {
    const holds = new StructuredAgentSessionHolds({
      resume: async () => {},
      hasProviderChild: () => false,
      isTurnActive: () => false,
      evict: async () => {},
      graceMs: 1
    })

    await expect(holds.hold('session-1', 'chat-1')).rejects.toThrow(
      'agent_session_ownership_unknown'
    )
    expect(holds.isHeld('session-1')).toBe(false)
    holds.dispose()
  })

  it('shares the synthesized ownership failure when resume publishes no child', async () => {
    const resumeGate = Promise.withResolvers<void>()
    const holds = new StructuredAgentSessionHolds({
      resume: async () => resumeGate.promise,
      hasProviderChild: () => false,
      isTurnActive: () => false,
      evict: async () => {},
      graceMs: 1
    })

    const desktop = holds.hold('session-1', 'desktop-chat')
    const paired = holds.hold('session-1', 'paired-chat')
    resumeGate.resolve()
    const failed = await Promise.allSettled([desktop, paired])

    expect(failed[0]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'agent_session_ownership_unknown' })
    })
    expect(failed[1]).toMatchObject({ status: 'rejected' })
    if (failed[0]?.status !== 'rejected' || failed[1]?.status !== 'rejected') {
      throw new Error('both holds must reject')
    }
    expect(failed[1].reason).toBe(failed[0].reason)
    expect(holds.isHeld('session-1')).toBe(false)
    holds.dispose()
  })

  it('single-flights concurrent resume requests until the provider child is published', async () => {
    const entered = Promise.withResolvers<void>()
    const resumeGate = Promise.withResolvers<void>()
    let child = false
    const resume = vi.fn(async () => {
      entered.resolve()
      await resumeGate.promise
      child = true
    })
    const holds = new StructuredAgentSessionHolds({
      resume,
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict: async () => {},
      graceMs: 1
    })

    const desktop = holds.hold('session-1', 'desktop-chat')
    await entered.promise
    const paired = holds.hold('session-1', 'paired-chat')
    await Promise.resolve()

    expect(resume).toHaveBeenCalledOnce()
    resumeGate.resolve()
    await expect(Promise.all([desktop, paired])).resolves.toEqual([undefined, undefined])
    expect(holds.isHeld('session-1')).toBe(true)
    holds.dispose()
  })

  it('shares a resume failure and permits a fresh retry after it settles', async () => {
    const failure = new Error('resume failed')
    const resumeGate = Promise.withResolvers<void>()
    let child = false
    const resume = vi.fn<() => Promise<void>>(async () => {
      await resumeGate.promise
      throw failure
    })
    const holds = new StructuredAgentSessionHolds({
      resume,
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict: async () => {},
      graceMs: 1
    })

    const desktop = holds.hold('session-1', 'desktop-chat')
    const paired = holds.hold('session-1', 'paired-chat')
    await Promise.resolve()
    expect(resume).toHaveBeenCalledOnce()

    resumeGate.resolve()
    const failed = await Promise.allSettled([desktop, paired])
    expect(failed).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure }
    ])
    expect(holds.isHeld('session-1')).toBe(false)

    resume.mockImplementation(async () => {
      child = true
    })
    await expect(holds.hold('session-1', 'retry-chat')).resolves.toBeUndefined()
    expect(resume).toHaveBeenCalledTimes(2)
    holds.dispose()
  })

  it('shares a failure after the pending resume temporarily publishes a child', async () => {
    const failure = new Error('settlement failed')
    const published = Promise.withResolvers<void>()
    const settlementGate = Promise.withResolvers<void>()
    let child = false
    const resume = vi.fn(async () => {
      child = true
      published.resolve()
      await settlementGate.promise
      throw failure
    })
    const holds = new StructuredAgentSessionHolds({
      resume,
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict: async () => {
        child = false
      },
      graceMs: 1
    })

    const desktop = holds.hold('session-1', 'desktop-chat')
    await published.promise
    const paired = holds.hold('session-1', 'paired-chat')
    await Promise.resolve()
    expect(resume).toHaveBeenCalledOnce()

    settlementGate.resolve()
    expect(await Promise.allSettled([desktop, paired])).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure }
    ])
    expect(holds.isHeld('session-1')).toBe(false)
    holds.dispose()
  })

  it('releases a child published after every holder left even when resume fails', async () => {
    const failure = new Error('settlement failed after publication')
    const resumeEntered = Promise.withResolvers<void>()
    const resumeGate = Promise.withResolvers<void>()
    let child = false
    const evict = vi.fn(async () => {
      child = false
    })
    const holds = new StructuredAgentSessionHolds({
      resume: async () => {
        resumeEntered.resolve()
        await resumeGate.promise
        child = true
        throw failure
      },
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict,
      graceMs: 1
    })

    const pending = holds.hold('session-1', 'desktop-chat')
    await resumeEntered.promise
    holds.release('session-1', 'desktop-chat')
    resumeGate.resolve()

    await expect(pending).rejects.toBe(failure)
    await vi.waitFor(() => expect(evict).toHaveBeenCalledOnce())
    expect(child).toBe(false)
    holds.dispose()
  })

  it('does not block another session behind a pending resume', async () => {
    const firstEntered = Promise.withResolvers<void>()
    const firstGate = Promise.withResolvers<void>()
    const children = new Set<string>()
    const resume = vi.fn(async (sessionId: string) => {
      if (sessionId === 'session-1') {
        firstEntered.resolve()
        await firstGate.promise
      }
      children.add(sessionId)
    })
    const holds = new StructuredAgentSessionHolds({
      resume,
      hasProviderChild: (sessionId) => children.has(sessionId),
      isTurnActive: () => false,
      evict: async () => {},
      graceMs: 1
    })

    const first = holds.hold('session-1', 'desktop-chat')
    await firstEntered.promise
    await expect(holds.hold('session-2', 'paired-chat')).resolves.toBeUndefined()
    expect(resume).toHaveBeenCalledWith('session-2', expect.any(Function))

    firstGate.resolve()
    await expect(first).resolves.toBeUndefined()
    holds.dispose()
  })

  it('releases a cancelled holder without cancelling another holder shared resume', async () => {
    const entered = Promise.withResolvers<void>()
    const resumeGate = Promise.withResolvers<void>()
    let child = false
    const evict = vi.fn(async () => {
      child = false
    })
    const holds = new StructuredAgentSessionHolds({
      resume: async () => {
        entered.resolve()
        await resumeGate.promise
        child = true
      },
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict,
      graceMs: 1
    })

    const desktop = holds.hold('session-1', 'desktop-chat')
    await entered.promise
    const paired = holds.hold('session-1', 'paired-chat')
    holds.release('session-1', 'desktop-chat')
    resumeGate.resolve()

    await expect(Promise.all([desktop, paired])).resolves.toEqual([undefined, undefined])
    expect(holds.isHeld('session-1')).toBe(true)
    expect(evict).not.toHaveBeenCalled()

    holds.release('session-1', 'paired-chat')
    await vi.waitFor(() => expect(evict).toHaveBeenCalledOnce())
    holds.dispose()
  })

  it('arms release when every holder leaves during a shared resume', async () => {
    const entered = Promise.withResolvers<void>()
    const resumeGate = Promise.withResolvers<void>()
    let child = false
    const evict = vi.fn(async () => {
      child = false
    })
    const holds = new StructuredAgentSessionHolds({
      resume: async () => {
        entered.resolve()
        await resumeGate.promise
        child = true
      },
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict,
      graceMs: 1
    })

    const desktop = holds.hold('session-1', 'desktop-chat')
    await entered.promise
    const paired = holds.hold('session-1', 'paired-chat')
    holds.release('session-1', 'desktop-chat')
    holds.release('session-1', 'paired-chat')
    resumeGate.resolve()

    await expect(Promise.all([desktop, paired])).resolves.toEqual([undefined, undefined])
    expect(holds.isHeld('session-1')).toBe(false)
    await vi.waitFor(() => expect(evict).toHaveBeenCalledOnce())
    holds.dispose()
  })

  it('waits for an in-flight eviction before registering a replacement hold', async () => {
    const evictionEntered = Promise.withResolvers<void>()
    const evictionGate = Promise.withResolvers<void>()
    let child = true
    const resume = vi.fn(async () => {
      child = true
    })
    let holds: StructuredAgentSessionHolds
    holds = new StructuredAgentSessionHolds({
      resume,
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict: async () => {
        evictionEntered.resolve()
        await evictionGate.promise
        child = false
        holds.forget('session-1')
      },
      graceMs: 1
    })

    await holds.hold('session-1', 'desktop-chat', { resume: false })
    holds.release('session-1', 'desktop-chat')
    await evictionEntered.promise
    const replacement = holds.hold('session-1', 'paired-chat')
    await Promise.resolve()

    expect(holds.isHeld('session-1')).toBe(false)
    expect(resume).not.toHaveBeenCalled()
    evictionGate.resolve()
    await expect(replacement).resolves.toBeUndefined()
    expect(resume).toHaveBeenCalledOnce()
    expect(holds.isHeld('session-1')).toBe(true)
    holds.dispose()
  })

  it('does not retain a hold released while eviction is still running', async () => {
    const evictionEntered = Promise.withResolvers<void>()
    const evictionGate = Promise.withResolvers<void>()
    let child = true
    const resume = vi.fn(async () => {
      child = true
    })
    let holds: StructuredAgentSessionHolds
    holds = new StructuredAgentSessionHolds({
      resume,
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict: async () => {
        evictionEntered.resolve()
        await evictionGate.promise
        child = false
        holds.forget('session-1')
      },
      graceMs: 1
    })

    const eviction = holds.evict('session-1')
    await evictionEntered.promise
    const retaining = holds.hold('session-1', 'subscription:paired', { resume: false })
    holds.release('session-1', 'subscription:paired')
    evictionGate.resolve()

    await eviction
    await expect(retaining).resolves.toBeUndefined()
    expect(holds.isHeld('session-1')).toBe(false)
    expect(resume).not.toHaveBeenCalled()
    holds.dispose()
  })

  it('rejects a hold still waiting for eviction when the host is disposed', async () => {
    const evictionEntered = Promise.withResolvers<void>()
    const evictionGate = Promise.withResolvers<void>()
    const resume = vi.fn(async () => {})
    const holds = new StructuredAgentSessionHolds({
      resume,
      hasProviderChild: () => false,
      isTurnActive: () => false,
      evict: async () => {
        evictionEntered.resolve()
        await evictionGate.promise
      },
      graceMs: 1
    })

    const eviction = holds.evict('session-1')
    await evictionEntered.promise
    const pending = holds.hold('session-1', 'paired-chat')
    holds.dispose()
    evictionGate.resolve()

    await eviction
    await expect(pending).rejects.toThrow('agent_session_ownership_unknown')
    expect(resume).not.toHaveBeenCalled()
    expect(holds.isHeld('session-1')).toBe(false)
  })

  it('retries failed teardown before admitting a later hold', async () => {
    const failure = new Error('teardown failed after stopping the child')
    const evictionEntered = Promise.withResolvers<void>()
    const evictionGate = Promise.withResolvers<void>()
    let child = true
    const resume = vi.fn(async () => {
      child = true
    })
    let attempts = 0
    let holds: StructuredAgentSessionHolds
    holds = new StructuredAgentSessionHolds({
      resume,
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict: async () => {
        attempts += 1
        if (attempts === 1) {
          evictionEntered.resolve()
          await evictionGate.promise
          throw failure
        }
        child = false
        holds.forget('session-1')
      },
      graceMs: 1
    })

    const eviction = holds.evict('session-1')
    await evictionEntered.promise
    const waiting = holds.hold('session-1', 'paired-chat')
    evictionGate.resolve()

    await expect(eviction).rejects.toBe(failure)
    await expect(waiting).rejects.toBe(failure)
    await expect(holds.hold('session-1', 'desktop-chat')).resolves.toBeUndefined()
    expect(attempts).toBe(2)
    expect(resume).toHaveBeenCalledOnce()
    expect(holds.isHeld('session-1')).toBe(true)
    holds.dispose()
  })

  it('retries an eviction that rejected without an error value', async () => {
    const evictionEntered = Promise.withResolvers<void>()
    const evictionGate = Promise.withResolvers<void>()
    const retryFailure = new Error('retry failed')
    const resume = vi.fn(async () => {})
    let attempts = 0
    const holds = new StructuredAgentSessionHolds({
      resume,
      hasProviderChild: () => true,
      isTurnActive: () => false,
      evict: async () => {
        attempts += 1
        if (attempts === 1) {
          evictionEntered.resolve()
          await evictionGate.promise
          throw undefined
        }
        throw retryFailure
      },
      graceMs: 1
    })

    const eviction = holds.evict('session-1')
    await evictionEntered.promise
    const waiting = holds.hold('session-1', 'paired-chat')
    evictionGate.resolve()

    const [evictionResult, waitingResult] = await Promise.allSettled([eviction, waiting])
    expect(evictionResult).toEqual({ status: 'rejected', reason: undefined })
    expect(waitingResult).toEqual({ status: 'rejected', reason: undefined })
    await expect(holds.hold('session-1', 'desktop-chat')).rejects.toBe(retryFailure)
    expect(attempts).toBe(2)
    expect(resume).not.toHaveBeenCalled()
    holds.dispose()
  })

  it('waits for an eviction chained before its hold continuation', async () => {
    const firstEntered = Promise.withResolvers<void>()
    const firstGate = Promise.withResolvers<void>()
    const secondEntered = Promise.withResolvers<void>()
    const secondGate = Promise.withResolvers<void>()
    let evictionCount = 0
    let child = true
    const resume = vi.fn(async () => {
      child = true
    })
    let holds: StructuredAgentSessionHolds
    holds = new StructuredAgentSessionHolds({
      resume,
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict: async () => {
        evictionCount += 1
        const entered = evictionCount === 1 ? firstEntered : secondEntered
        const gate = evictionCount === 1 ? firstGate : secondGate
        entered.resolve()
        await gate.promise
        child = false
        holds.forget('session-1')
      },
      graceMs: 1
    })

    const first = holds.evict('session-1')
    await firstEntered.promise
    const chained = first.then(() => holds.evict('session-1'))
    const replacement = holds.hold('session-1', 'paired-chat')
    firstGate.resolve()
    await secondEntered.promise
    await Promise.resolve()

    expect(holds.isHeld('session-1')).toBe(false)
    expect(resume).not.toHaveBeenCalled()
    secondGate.resolve()
    await chained
    await expect(replacement).resolves.toBeUndefined()
    expect(resume).toHaveBeenCalledOnce()
    expect(holds.isHeld('session-1')).toBe(true)
    holds.dispose()
  })

  it('invalidates a pending resume before eviction starts', async () => {
    const resumeEntered = Promise.withResolvers<void>()
    const resumeGate = Promise.withResolvers<void>()
    let resumeWasCurrent = true
    const evict = vi.fn(async () => {})
    const holds = new StructuredAgentSessionHolds({
      resume: async (_sessionId, isCurrent) => {
        resumeEntered.resolve()
        await resumeGate.promise
        resumeWasCurrent = isCurrent()
        if (!resumeWasCurrent) {
          throw new Error('agent_session_ownership_unknown')
        }
      },
      hasProviderChild: () => false,
      isTurnActive: () => false,
      evict,
      graceMs: 1
    })

    const pending = holds.hold('session-1', 'desktop-chat')
    await resumeEntered.promise
    await holds.evict('session-1')
    resumeGate.resolve()

    await expect(pending).rejects.toThrow('agent_session_ownership_unknown')
    expect(resumeWasCurrent).toBe(false)
    expect(evict).toHaveBeenCalledOnce()
    expect(holds.isHeld('session-1')).toBe(false)
    holds.dispose()
  })

  it('does not let a forgotten resume settle a replacement of the same holder', async () => {
    const firstEntered = Promise.withResolvers<void>()
    const firstGate = Promise.withResolvers<void>()
    const firstFailure = new Error('forgotten resume failed')
    let child = false
    const resume = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        firstEntered.resolve()
        await firstGate.promise
        throw firstFailure
      })
      .mockImplementationOnce(async () => {
        child = true
      })
    const holds = new StructuredAgentSessionHolds({
      resume,
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict: async () => {},
      graceMs: 1
    })

    const forgotten = holds.hold('session-1', 'desktop-chat')
    await firstEntered.promise
    holds.forget('session-1')
    await expect(holds.hold('session-1', 'desktop-chat')).resolves.toBeUndefined()

    firstGate.resolve()
    await expect(forgotten).rejects.toBe(firstFailure)
    expect(resume).toHaveBeenCalledTimes(2)
    expect(holds.isHeld('session-1')).toBe(true)
    holds.dispose()
  })

  it('does not report a forgotten hold as live after its resume succeeds', async () => {
    const entered = Promise.withResolvers<void>()
    const resumeGate = Promise.withResolvers<void>()
    let child = false
    const evict = vi.fn(async () => {
      child = false
    })
    const holds = new StructuredAgentSessionHolds({
      resume: async () => {
        entered.resolve()
        await resumeGate.promise
        child = true
      },
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict,
      graceMs: 1
    })

    const forgotten = holds.hold('session-1', 'desktop-chat')
    await entered.promise
    holds.forget('session-1')
    resumeGate.resolve()

    await expect(forgotten).rejects.toThrow('agent_session_ownership_unknown')
    expect(holds.isHeld('session-1')).toBe(false)
    await vi.waitFor(() => expect(evict).toHaveBeenCalledOnce())
    holds.dispose()
  })

  it('releases a forgotten child when its replacement resume fails', async () => {
    const firstGate = Promise.withResolvers<void>()
    const secondGate = Promise.withResolvers<void>()
    const replacementFailure = new Error('replacement resume failed')
    let child = false
    const evict = vi.fn(async () => {
      child = false
    })
    const resume = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(async () => {
        await firstGate.promise
        child = true
      })
      .mockImplementationOnce(async () => {
        await secondGate.promise
        throw replacementFailure
      })
    const holds = new StructuredAgentSessionHolds({
      resume,
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict,
      graceMs: 1
    })

    const forgotten = holds.hold('session-1', 'desktop-chat')
    await Promise.resolve()
    holds.forget('session-1')
    const replacement = holds.hold('session-1', 'paired-chat')
    await Promise.resolve()

    firstGate.resolve()
    await expect(forgotten).rejects.toThrow('agent_session_ownership_unknown')
    secondGate.resolve()
    await expect(replacement).rejects.toBe(replacementFailure)
    expect(holds.isHeld('session-1')).toBe(false)
    await vi.waitFor(() => expect(evict).toHaveBeenCalledOnce())
    holds.dispose()
  })

  it('invalidates a pending resume when the host is disposed', async () => {
    const entered = Promise.withResolvers<void>()
    const resumeGate = Promise.withResolvers<void>()
    let resumeWasCurrent = true
    let child = false
    const evict = vi.fn(async () => {})
    const holds = new StructuredAgentSessionHolds({
      resume: async (_sessionId, isCurrent) => {
        entered.resolve()
        await resumeGate.promise
        resumeWasCurrent = isCurrent()
        if (!resumeWasCurrent) {
          throw new Error('agent_session_ownership_unknown')
        }
        child = true
      },
      hasProviderChild: () => child,
      isTurnActive: () => false,
      evict,
      graceMs: 1
    })

    const pending = holds.hold('session-1', 'desktop-chat')
    await entered.promise
    holds.dispose()
    resumeGate.resolve()
    await expect(pending).rejects.toThrow('agent_session_ownership_unknown')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(resumeWasCurrent).toBe(false)
    expect(child).toBe(false)
    expect(holds.isHeld('session-1')).toBe(false)
    expect(holds.isReleasePending('session-1')).toBe(false)
    expect(evict).not.toHaveBeenCalled()
  })
})

describe('the teardown deadline', () => {
  it('leaves the child loaded instead of forcing it, and keeps the session indexed', async () => {
    const forget = vi.fn()
    const releaseLease = vi.fn(async () => {})

    await expect(
      evictStructuredAgentSession(
        {
          sessionId: 'session-1',
          eventSink: {
            unbind: vi.fn(),
            drained: vi.fn(async () => {}),
            close: vi.fn()
          } as never,
          adapter: { closeSession: () => new Promise<void>(() => {}) } as never,
          forget,
          discardSink: vi.fn(),
          releaseLease
        },
        withStructuredAgentSessionEvictionDeadline(STRUCTURED_AGENT_SESSION_EVICTION_STEPS, 5)
      )
    ).rejects.toMatchObject({ step: 'stop-provider-child' })

    expect(forget).not.toHaveBeenCalled()
    expect(releaseLease).not.toHaveBeenCalled()
  })

  it('names the step that ran out of time', async () => {
    const [step] = withStructuredAgentSessionEvictionDeadline(
      [{ name: 'slow-step', run: () => new Promise<void>(() => {}) }],
      5
    )

    await expect(step?.run({} as never)).rejects.toBeInstanceOf(
      StructuredAgentSessionEvictionTimeoutError
    )
  })

  it('does not delay a step that finishes', async () => {
    const ran: string[] = []
    const steps = withStructuredAgentSessionEvictionDeadline(
      [{ name: 'fast-step', run: () => void ran.push('fast-step') }],
      5_000
    )

    await steps[0]?.run({} as never)

    expect(ran).toEqual(['fast-step'])
  })
})
