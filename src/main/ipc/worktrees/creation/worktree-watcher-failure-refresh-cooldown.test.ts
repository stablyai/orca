import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeWatcherFailureRefreshCooldown } from './worktree-watcher-failure-refresh-cooldown'

describe('WorktreeWatcherFailureRefreshCooldown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers a cooled-down failure refresh once the cooldown ends instead of dropping it', () => {
    const cooldown = new WorktreeWatcherFailureRefreshCooldown()
    const refresh = vi.fn()
    expect(cooldown.consume()).toBe(true)

    vi.advanceTimersByTime(10_000)
    expect(cooldown.consume()).toBe(false)
    cooldown.defer(refresh)
    cooldown.defer(refresh)
    vi.advanceTimersByTime(49_999)
    expect(refresh).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(cooldown.consume()).toBe(false)
  })
})
