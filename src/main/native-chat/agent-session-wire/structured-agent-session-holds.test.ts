// The parts a session's lifetime is assembled from: the holder set, the release clock, and the
// deadline that keeps teardown from hanging.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { runKeyedSerializedOperation } from '../../cli/keyed-promise-queue'
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

/** The host's per-session queue, so a hold and a writer really take turns. */
function keyedSerialize() {
  const chains = new Map<string, Promise<void>>()
  return <T>(sessionId: string, task: () => Promise<T>) =>
    runKeyedSerializedOperation(chains, sessionId, task)
}

function clock(deps: {
  hasOwedWork?: () => boolean
  isHeld?: () => boolean
  evict: (sessionId: string) => Promise<void>
  onError?: (input: { sessionId: string; error: unknown }) => void
}): StructuredAgentSessionReleaseClock {
  const created = new StructuredAgentSessionReleaseClock({
    hasOwedWork: deps.hasOwedWork ?? (() => false),
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
    const releasing = clock({ hasOwedWork: () => turnRunning, evict })

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

  it('keeps an idle unheld child for thirty minutes, and activity starts the window over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const evict = vi.fn(async () => {})
      const idle = new StructuredAgentSessionReleaseClock({
        hasOwedWork: () => false,
        isHeld: () => false,
        evict
      })
      clocks.push(idle)
      const minutes = (count: number) => vi.advanceTimersByTimeAsync(count * 60_000)

      idle.arm('session-1')
      await minutes(20)
      idle.renew('session-1')
      await minutes(29)
      expect(evict).not.toHaveBeenCalled()

      await minutes(1)
      expect(evict).toHaveBeenCalledWith('session-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a window for a session nothing released', async () => {
    const evict = vi.fn(async () => {})
    const releasing = clock({ evict })

    releasing.renew('session-1')
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(releasing.isArmed('session-1')).toBe(false)
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
      return { ok: true as const }
    })
    const holds = new StructuredAgentSessionHolds({
      resume,
      serialize: keyedSerialize(),
      hasProviderChild: () => child,
      hasOwedWork: () => false,
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

  it('runs one resume for a writer and a hold that ask in the same gap', async () => {
    const gate = Promise.withResolvers<void>()
    let child = false
    const resume = vi.fn(async () => {
      await gate.promise
      child = true
      return { ok: true as const }
    })
    const serialize = keyedSerialize()
    const holds = new StructuredAgentSessionHolds({
      resume,
      serialize,
      hasProviderChild: () => child,
      hasOwedWork: () => false,
      evict: async () => {},
      graceMs: 1
    })

    // A send's ensure-owner step: already inside the session's serialize when it asks.
    const writer = serialize('session-1', () => holds.ensureProviderChild('session-1'))
    const hold = holds.hold('session-1', 'chat-1')
    gate.resolve()

    await expect(writer).resolves.toEqual({ ok: true })
    await hold
    // The hold ran after the writer's step and found the child: nothing to resume.
    expect(resume).toHaveBeenCalledOnce()
    // The surface arrived while the writer's resume ran, so the child it got is held, not idle.
    expect(holds.isHeld('session-1')).toBe(true)
    expect(holds.isReleasePending('session-1')).toBe(false)
    holds.dispose()
  })

  it('puts a child a writer resumed with no surface on the idle clock', async () => {
    let child = false
    const serialize = keyedSerialize()
    const holds = new StructuredAgentSessionHolds({
      resume: async () => {
        child = true
        return { ok: true as const }
      },
      serialize,
      hasProviderChild: () => child,
      hasOwedWork: () => false,
      evict: async () => {},
      graceMs: 60_000
    })

    await serialize('session-1', () => holds.ensureProviderChild('session-1'))

    expect(holds.isHeld('session-1')).toBe(false)
    expect(holds.isReleasePending('session-1')).toBe(true)
    holds.dispose()
  })

  it('never arms the clock for a session with nothing to stop', async () => {
    const evict = vi.fn(async () => {})
    const holds = new StructuredAgentSessionHolds({
      resume: async () => ({ ok: true as const }),
      serialize: keyedSerialize(),
      hasProviderChild: () => false,
      hasOwedWork: () => false,
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
      resume: async () => ({ ok: true as const }),
      serialize: keyedSerialize(),
      hasProviderChild: () => false,
      hasOwedWork: () => false,
      evict: async () => {},
      graceMs: 1
    })

    await expect(holds.hold('session-1', 'chat-1')).rejects.toMatchObject({
      code: 'agent_session_ownership_unknown',
      message: 'The session attached without a provider child to write to.'
    })
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
