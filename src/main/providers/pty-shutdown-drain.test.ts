import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from './types'
import {
  PTY_EXIT_DRAIN_WINDOW_MS,
  isPtyAlreadyGoneError,
  shutdownPtyWithDrain
} from './pty-shutdown-drain'

type ExitPayload = { id: string; code: number }

function createProvider(): {
  provider: IPtyProvider
  shutdown: ReturnType<typeof vi.fn>
  emitExit: (payload: ExitPayload) => void
} {
  const exitListeners = new Set<(payload: ExitPayload) => void>()
  const shutdown = vi.fn().mockResolvedValue(undefined)
  const provider = {
    shutdown,
    onExit: (cb: (payload: ExitPayload) => void) => {
      exitListeners.add(cb)
      return () => exitListeners.delete(cb)
    }
  } as unknown as IPtyProvider
  return {
    provider,
    shutdown,
    emitExit: (payload) => {
      for (const listener of exitListeners) {
        listener(payload)
      }
    }
  }
}

describe('shutdownPtyWithDrain', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not escalate when the PTY exits inside the drain window', async () => {
    const { provider, shutdown, emitExit } = createProvider()
    shutdown.mockImplementation(async (id: string, opts: { immediate?: boolean }) => {
      if (!opts.immediate) {
        emitExit({ id, code: 0 })
      }
    })

    const exited = await shutdownPtyWithDrain(provider, 'pty-1', {})

    expect(exited).toBe(true)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(shutdown).toHaveBeenCalledWith('pty-1', { immediate: false, keepHistory: undefined })
  })

  it('ignores exit events for other PTY ids', async () => {
    vi.useFakeTimers()
    const { provider, shutdown, emitExit } = createProvider()
    shutdown.mockImplementation(async (_id: string, opts: { immediate?: boolean }) => {
      if (!opts.immediate) {
        emitExit({ id: 'unrelated', code: 0 })
      }
    })

    const result = shutdownPtyWithDrain(provider, 'pty-1', {})
    await vi.advanceTimersByTimeAsync(PTY_EXIT_DRAIN_WINDOW_MS)

    expect(await result).toBe(false)
    expect(shutdown).toHaveBeenLastCalledWith('pty-1', { immediate: true, keepHistory: undefined })
  })

  it('escalates to an immediate shutdown when the drain window expires', async () => {
    vi.useFakeTimers()
    const { provider, shutdown } = createProvider()

    const result = shutdownPtyWithDrain(provider, 'pty-1', { keepHistory: true })
    await vi.advanceTimersByTimeAsync(PTY_EXIT_DRAIN_WINDOW_MS)

    expect(await result).toBe(false)
    expect(shutdown).toHaveBeenCalledTimes(2)
    expect(shutdown).toHaveBeenNthCalledWith(1, 'pty-1', { immediate: false, keepHistory: true })
    expect(shutdown).toHaveBeenNthCalledWith(2, 'pty-1', { immediate: true, keepHistory: true })
  })

  it('honors a caller-provided drain window', async () => {
    vi.useFakeTimers()
    const { provider, shutdown } = createProvider()

    const result = shutdownPtyWithDrain(provider, 'pty-1', { drainWindowMs: 50 })
    await vi.advanceTimersByTimeAsync(50)

    expect(await result).toBe(false)
    expect(shutdown).toHaveBeenCalledTimes(2)
  })

  it('treats an already-gone session during escalation as success', async () => {
    vi.useFakeTimers()
    const { provider, shutdown } = createProvider()
    shutdown.mockImplementation(async (_id: string, opts: { immediate?: boolean }) => {
      if (opts.immediate) {
        throw new Error('Session not found: pty-1')
      }
    })

    const result = shutdownPtyWithDrain(provider, 'pty-1', {})
    await vi.advanceTimersByTimeAsync(PTY_EXIT_DRAIN_WINDOW_MS)

    await expect(result).resolves.toBe(false)
  })

  it('propagates non-already-gone escalation failures', async () => {
    vi.useFakeTimers()
    const { provider, shutdown } = createProvider()
    shutdown.mockImplementation(async (_id: string, opts: { immediate?: boolean }) => {
      if (opts.immediate) {
        throw new Error('relay transport lost')
      }
    })

    const result = shutdownPtyWithDrain(provider, 'pty-1', {})
    // Why: attach the rejection expectation before advancing timers so the
    // rejection is never unhandled.
    const assertion = expect(result).rejects.toThrow('relay transport lost')
    await vi.advanceTimersByTimeAsync(PTY_EXIT_DRAIN_WINDOW_MS)
    await assertion
  })

  it('still escalates to a forced shutdown when the graceful request fails', async () => {
    const { provider, shutdown } = createProvider()
    shutdown.mockImplementation(async (_id: string, opts: { immediate?: boolean }) => {
      if (!opts.immediate) {
        throw new Error('boom')
      }
    })

    // Why: a failed graceful signal must not leave the PTY un-reaped — callers
    // (worktree removal) delete files right after this resolves.
    await expect(shutdownPtyWithDrain(provider, 'pty-1', {})).resolves.toBe(false)
    expect(shutdown).toHaveBeenCalledTimes(2)
    expect(shutdown).toHaveBeenLastCalledWith('pty-1', { immediate: true, keepHistory: undefined })
  })

  it('propagates already-gone graceful failures without escalating', async () => {
    const { provider, shutdown } = createProvider()
    shutdown.mockRejectedValue(new Error('Session not found: pty-1'))

    await expect(shutdownPtyWithDrain(provider, 'pty-1', {})).rejects.toThrow('Session not found')
    expect(shutdown).toHaveBeenCalledTimes(1)
  })
})

describe('isPtyAlreadyGoneError', () => {
  it('matches daemon session-not-found errors', () => {
    expect(isPtyAlreadyGoneError(new Error('Session not found: abc'))).toBe(true)
    expect(isPtyAlreadyGoneError(new Error('relay transport lost'))).toBe(false)
  })
})
