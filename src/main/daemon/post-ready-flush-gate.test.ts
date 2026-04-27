import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PostReadyFlushGate,
  POST_READY_FLUSH_DELAY_MS,
  POST_READY_FLUSH_FALLBACK_MS
} from './post-ready-flush-gate'

describe('PostReadyFlushGate', () => {
  let onFlush: ReturnType<typeof vi.fn<() => void>>
  let gate: PostReadyFlushGate

  beforeEach(() => {
    vi.useFakeTimers()
    onFlush = vi.fn<() => void>()
    gate = new PostReadyFlushGate(onFlush)
  })

  afterEach(() => {
    gate.clear()
    vi.useRealTimers()
  })

  it('does not flush immediately when armed', () => {
    gate.arm()
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('flushes via short delay after notifyData signals the prompt draw', () => {
    gate.arm()
    gate.notifyData()
    expect(onFlush).not.toHaveBeenCalled()

    vi.advanceTimersByTime(POST_READY_FLUSH_DELAY_MS)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('flushes via wall-clock fallback when no notifyData arrives', () => {
    gate.arm()

    vi.advanceTimersByTime(POST_READY_FLUSH_FALLBACK_MS)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('ignores notifyData before arm()', () => {
    gate.notifyData()
    vi.advanceTimersByTime(1000)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('notifyData after the fallback fired is a no-op', () => {
    gate.arm()
    vi.advanceTimersByTime(POST_READY_FLUSH_FALLBACK_MS)
    expect(onFlush).toHaveBeenCalledTimes(1)

    gate.notifyData()
    vi.advanceTimersByTime(1000)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('only the first notifyData schedules the short-delay flush', () => {
    gate.arm()
    gate.notifyData()
    gate.notifyData()
    gate.notifyData()

    vi.advanceTimersByTime(POST_READY_FLUSH_DELAY_MS)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })

  it('clear() cancels a pending fallback flush', () => {
    gate.arm()
    gate.clear()

    vi.advanceTimersByTime(POST_READY_FLUSH_FALLBACK_MS * 2)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('clear() cancels a pending post-data flush', () => {
    gate.arm()
    gate.notifyData()
    gate.clear()

    vi.advanceTimersByTime(POST_READY_FLUSH_DELAY_MS * 2)
    expect(onFlush).not.toHaveBeenCalled()
  })

  it('isPending is true throughout the gate window and false once flush fires', () => {
    expect(gate.isPending).toBe(false)
    gate.arm()
    expect(gate.isPending).toBe(true)
    gate.notifyData()
    expect(gate.isPending).toBe(true)
    vi.advanceTimersByTime(POST_READY_FLUSH_DELAY_MS)
    expect(gate.isPending).toBe(false)
    expect(onFlush).toHaveBeenCalledTimes(1)
  })
})
