import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebContentsTimedFlag } from './web-contents-timed-flag'

describe('web contents timed flag', () => {
  afterEach(() => vi.useRealTimers())

  it('consumes interleaved web contents independently', () => {
    const flag = createWebContentsTimedFlag()

    flag.mark(11)
    flag.mark(22)

    expect(flag.matches(11, { consume: true })).toBe(true)
    expect(flag.matches(22)).toBe(true)
    flag.clear(22)
    expect(flag.matches(22)).toBe(false)

    flag.mark(11)
    flag.mark(22)
    flag.clear(11)
    expect(flag.matches(11)).toBe(false)
    expect(flag.matches(22)).toBe(true)
  })

  it('expires each web contents independently', () => {
    vi.useFakeTimers()
    const flag = createWebContentsTimedFlag()

    flag.mark(11, 50)
    flag.mark(22, 100)
    vi.advanceTimersByTime(51)

    expect(flag.matches(11)).toBe(false)
    expect(flag.matches(22)).toBe(true)

    flag.mark(11, 100)
    flag.mark(22, 50)
    vi.advanceTimersByTime(51)
    expect(flag.matches(11)).toBe(true)
    expect(flag.matches(22)).toBe(false)
  })

  it('re-marking one web contents replaces only its expiry', () => {
    vi.useFakeTimers()
    const flag = createWebContentsTimedFlag()

    flag.mark(11, 50)
    flag.mark(22, 100)
    vi.advanceTimersByTime(40)
    flag.mark(11, 100)
    vi.advanceTimersByTime(61)

    expect(flag.matches(11)).toBe(true)
    expect(flag.matches(22)).toBe(false)
  })
})
