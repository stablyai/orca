import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StructuredAgentSessionHolds } from './structured-agent-session-holds'

const GRACE_MS = 15_000
const pendingHolds: StructuredAgentSessionHolds[] = []

function resumeHarness() {
  const resumeGate = Promise.withResolvers<void>()
  let child = false
  let turnActive = false
  const evict = vi.fn(async () => {
    child = false
  })
  const holds = new StructuredAgentSessionHolds({
    resume: async () => {
      await resumeGate.promise
      child = true
    },
    hasProviderChild: () => child,
    isTurnActive: () => turnActive,
    evict,
    graceMs: GRACE_MS
  })
  pendingHolds.push(holds)
  return {
    holds,
    resumeGate,
    evict,
    hasChild: () => child,
    setTurnActive: (value: boolean) => {
      turnActive = value
    }
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const holds of pendingHolds.splice(0)) {
    holds.dispose()
  }
  vi.useRealTimers()
})

describe('a surface leaving while its structured session resumes', () => {
  it('releases the acquired child after the last surface disconnects during resume', async () => {
    const { holds, resumeGate, evict, hasChild } = resumeHarness()
    const hold = holds.hold('session-1', 'connection-1:chat')

    holds.release('session-1', 'connection-1:chat')
    expect(holds.isReleasePending('session-1')).toBe(false)
    resumeGate.resolve()
    await hold

    expect(hasChild()).toBe(true)
    expect(holds.isHeld('session-1')).toBe(false)
    expect(holds.isReleasePending('session-1')).toBe(true)
    await vi.advanceTimersByTimeAsync(GRACE_MS - 1)
    expect(evict).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(evict).toHaveBeenCalledExactlyOnceWith('session-1')
    expect(hasChild()).toBe(false)
  })

  it('waits for an active turn before releasing the late child', async () => {
    const { holds, resumeGate, evict, setTurnActive } = resumeHarness()
    const hold = holds.hold('session-1', 'connection-1:chat')
    holds.release('session-1', 'connection-1:chat')
    setTurnActive(true)
    resumeGate.resolve()
    await hold

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2)
    expect(evict).not.toHaveBeenCalled()
    expect(holds.isReleasePending('session-1')).toBe(true)

    setTurnActive(false)
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(evict).toHaveBeenCalledExactlyOnceWith('session-1')
  })

  it.each([false, true])('preserves an arriving holder with resume=%s', async (resume) => {
    const { holds, resumeGate, evict } = resumeHarness()
    const first = holds.hold('session-1', 'connection-1:chat')
    holds.release('session-1', 'connection-1:chat')
    const replacement = holds.hold('session-1', 'connection-2:chat', { resume })
    resumeGate.resolve()
    await Promise.all([first, replacement])

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2)
    expect(holds.isHeld('session-1')).toBe(true)
    expect(holds.isReleasePending('session-1')).toBe(false)
    expect(evict).not.toHaveBeenCalled()

    holds.release('session-1', 'connection-2:chat')
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(evict).toHaveBeenCalledExactlyOnceWith('session-1')
  })

  it('cancels the late-child release when a surface reconnects during grace', async () => {
    const { holds, resumeGate, evict } = resumeHarness()
    const hold = holds.hold('session-1', 'connection-1:chat')
    holds.release('session-1', 'connection-1:chat')
    resumeGate.resolve()
    await hold
    expect(holds.isReleasePending('session-1')).toBe(true)

    await holds.hold('session-1', 'connection-2:chat')
    await vi.advanceTimersByTimeAsync(GRACE_MS * 2)
    expect(holds.isReleasePending('session-1')).toBe(false)
    expect(evict).not.toHaveBeenCalled()
  })

  it('preserves a failed resume without scheduling eviction', async () => {
    const { holds, resumeGate, evict, hasChild } = resumeHarness()
    const failure = new Error('provider acquisition failed')
    const hold = holds.hold('session-1', 'connection-1:chat')
    const rejected = expect(hold).rejects.toBe(failure)
    holds.release('session-1', 'connection-1:chat')
    resumeGate.reject(failure)
    await rejected

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2)
    expect(hasChild()).toBe(false)
    expect(holds.isHeld('session-1')).toBe(false)
    expect(holds.isReleasePending('session-1')).toBe(false)
    expect(evict).not.toHaveBeenCalled()
  })

  it('leaves late acquisition cleanup to host teardown after disposal', async () => {
    const { holds, resumeGate, evict } = resumeHarness()
    const hold = holds.hold('session-1', 'connection-1:chat')
    holds.release('session-1', 'connection-1:chat')
    holds.dispose()
    resumeGate.resolve()
    await hold

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2)
    expect(holds.isReleasePending('session-1')).toBe(false)
    expect(evict).not.toHaveBeenCalled()
  })

  it('does not restart release timers when a surface leaves after disposal', async () => {
    const { holds, resumeGate, evict } = resumeHarness()
    const hold = holds.hold('session-1', 'connection-1:chat')
    resumeGate.resolve()
    await hold
    holds.dispose()
    holds.release('session-1', 'connection-1:chat')

    await vi.advanceTimersByTimeAsync(GRACE_MS * 2)
    expect(holds.isHeld('session-1')).toBe(false)
    expect(holds.isReleasePending('session-1')).toBe(false)
    expect(evict).not.toHaveBeenCalled()
  })

  it('releases a late child acquired after explicit close forgot its holders', async () => {
    const { holds, resumeGate, evict } = resumeHarness()
    const hold = holds.hold('session-1', 'connection-1:chat')
    holds.forget('session-1')
    resumeGate.resolve()
    await hold

    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(holds.isHeld('session-1')).toBe(false)
    expect(evict).toHaveBeenCalledExactlyOnceWith('session-1')
  })

  it.each([false, true])(
    'keeps a reused holder when old resume fails (replacement finished=%s)',
    async (replacementFinished) => {
      const firstGate = Promise.withResolvers<void>()
      const replacementGate = Promise.withResolvers<void>()
      let child = false
      const resume = vi
        .fn()
        .mockImplementationOnce(() => firstGate.promise)
        .mockImplementationOnce(async () => {
          await replacementGate.promise
          child = true
        })
      const evict = vi.fn(async () => {})
      const holds = new StructuredAgentSessionHolds({
        resume,
        hasProviderChild: () => child,
        isTurnActive: () => false,
        evict,
        graceMs: GRACE_MS
      })
      pendingHolds.push(holds)
      const first = holds.hold('session-1', 'same-holder')
      const rejected = expect(first).rejects.toThrow('old acquisition failed')
      holds.release('session-1', 'same-holder')
      const replacement = holds.hold('session-1', 'same-holder')
      if (replacementFinished) {
        replacementGate.resolve()
        await replacement
      }

      firstGate.reject(new Error('old acquisition failed'))
      await rejected
      expect(holds.isHeld('session-1')).toBe(true)
      replacementGate.resolve()
      await replacement
      await vi.advanceTimersByTimeAsync(GRACE_MS * 2)
      expect(evict).not.toHaveBeenCalled()

      holds.release('session-1', 'same-holder')
      await vi.advanceTimersByTimeAsync(GRACE_MS)
      expect(evict).toHaveBeenCalledExactlyOnceWith('session-1')
    }
  )

  it('removes a failed replacement while the released old hold is still pending', async () => {
    const firstGate = Promise.withResolvers<void>()
    const resume = vi
      .fn()
      .mockImplementationOnce(() => firstGate.promise)
      .mockRejectedValueOnce(new Error('replacement acquisition failed'))
    const holds = new StructuredAgentSessionHolds({
      resume,
      hasProviderChild: () => false,
      isTurnActive: () => false,
      evict: async () => {},
      graceMs: GRACE_MS
    })
    pendingHolds.push(holds)
    const first = holds.hold('session-1', 'same-holder')
    const rejected = expect(first).rejects.toThrow('old acquisition failed')
    holds.release('session-1', 'same-holder')

    await expect(holds.hold('session-1', 'same-holder')).rejects.toThrow(
      'replacement acquisition failed'
    )
    expect(holds.isHeld('session-1')).toBe(false)
    expect(holds.isReleasePending('session-1')).toBe(false)

    firstGate.reject(new Error('old acquisition failed'))
    await rejected
    expect(holds.isHeld('session-1')).toBe(false)
  })

  it.each(['old-holder', 'different-holder'])(
    'releases the old acquisition after replacement %s fails, once its turn finishes',
    async (replacementHolder) => {
      const firstGate = Promise.withResolvers<void>()
      const replacementGate = Promise.withResolvers<void>()
      let child = false
      let turnActive = true
      const resume = vi
        .fn()
        .mockImplementationOnce(async () => {
          await firstGate.promise
          child = true
        })
        .mockImplementationOnce(() => replacementGate.promise)
      const evict = vi.fn(async () => {
        child = false
      })
      const holds = new StructuredAgentSessionHolds({
        resume,
        hasProviderChild: () => child,
        isTurnActive: () => turnActive,
        evict,
        graceMs: GRACE_MS
      })
      pendingHolds.push(holds)
      const first = holds.hold('session-1', 'old-holder')
      holds.release('session-1', 'old-holder')
      const replacement = holds.hold('session-1', replacementHolder)
      const rejected = expect(replacement).rejects.toThrow('replacement acquisition failed')
      firstGate.resolve()
      await first
      expect(holds.isReleasePending('session-1')).toBe(false)

      replacementGate.reject(new Error('replacement acquisition failed'))
      await rejected
      expect(holds.isHeld('session-1')).toBe(false)
      expect(holds.isReleasePending('session-1')).toBe(true)
      await vi.advanceTimersByTimeAsync(GRACE_MS)
      expect(evict).not.toHaveBeenCalled()
      expect(child).toBe(true)

      turnActive = false
      await vi.advanceTimersByTimeAsync(GRACE_MS)
      expect(evict).toHaveBeenCalledExactlyOnceWith('session-1')
      expect(child).toBe(false)
    }
  )
})
