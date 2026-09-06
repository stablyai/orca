// The parts a session's lifetime is assembled from: the holder set, the release clock, and the
// deadline that keeps teardown from hanging.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { StructuredAgentSessionHolders } from './structured-agent-session-holders'
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

describe('the holder set', () => {
  it('reports the first and last holder, and nothing in between', () => {
    const holders = new StructuredAgentSessionHolders()

    expect(holders.add('session-1', 'a')).toBe(true)
    expect(holders.add('session-1', 'b')).toBe(false)
    expect(holders.remove('session-1', 'a')).toBe(false)
    expect(holders.remove('session-1', 'b')).toBe(true)
    expect(holders.isHeld('session-1')).toBe(false)
  })

  // The reason this is a set and not a count: every release path can fire twice or not at all.
  it('absorbs a duplicate hold and a duplicate release', () => {
    const holders = new StructuredAgentSessionHolders()

    holders.add('session-1', 'a')
    holders.add('session-1', 'a')
    expect(holders.remove('session-1', 'a')).toBe(true)
    expect(holders.remove('session-1', 'a')).toBe(false)
    expect(holders.holderIds('session-1')).toEqual([])
  })

  it('keeps one session holders out of another session holders', () => {
    const holders = new StructuredAgentSessionHolders()

    holders.add('session-1', 'a')
    holders.add('session-2', 'a')
    holders.remove('session-1', 'a')

    expect(holders.isHeld('session-1')).toBe(false)
    expect(holders.isHeld('session-2')).toBe(true)
  })

  it('distinguishes retaining holders from holders that may resume a provider', () => {
    const holders = new StructuredAgentSessionHolders()

    holders.add('session-1', 'subscriber', false)
    expect(holders.hasResumeCapableHolder('session-1')).toBe(false)

    holders.add('session-1', 'chat', true)
    expect(holders.hasResumeCapableHolder('session-1')).toBe(true)
    holders.remove('session-1', 'chat')
    expect(holders.hasResumeCapableHolder('session-1')).toBe(false)
  })
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
