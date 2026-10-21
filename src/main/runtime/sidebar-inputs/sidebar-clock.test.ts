import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarClock } from './sidebar-clock'

describe('SidebarClock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms one timer for the earliest of every pending deadline', () => {
    const clock = new SidebarClock()
    const fired: string[] = []
    clock.schedule('late', 300, () => fired.push('late'))
    clock.schedule('early', 100, () => fired.push('early'))
    clock.schedule('mid', 200, () => fired.push('mid'))
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(100)
    expect(fired).toEqual(['early'])
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(200)
    expect(fired).toEqual(['early', 'mid', 'late'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('replaces a key, cancels it, and lets a fire schedule its next deadline', () => {
    const clock = new SidebarClock()
    const fired: number[] = []
    clock.schedule('a', 100, () => fired.push(1))
    clock.schedule('a', 50, () => fired.push(2))
    vi.advanceTimersByTime(60)
    expect(fired).toEqual([2])

    clock.schedule('b', 500, () => fired.push(3))
    clock.cancel('b')
    expect(vi.getTimerCount()).toBe(0)

    const tick = (): void => {
      fired.push(4)
      if (fired.filter((n) => n === 4).length < 3) {
        clock.schedule('tick', Date.now() + 10, tick)
      }
    }
    clock.schedule('tick', Date.now() + 10, tick)
    vi.advanceTimersByTime(100)
    expect(fired.filter((n) => n === 4)).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps firing the rest when one deadline throws', () => {
    const clock = new SidebarClock()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fired: string[] = []
    clock.schedule('bad', 10, () => {
      throw new Error('boom')
    })
    clock.schedule('good', 10, () => fired.push('good'))
    vi.advanceTimersByTime(10)
    expect(fired).toEqual(['good'])
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })
})
