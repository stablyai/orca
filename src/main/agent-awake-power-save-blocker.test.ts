import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_AWAKE_BLOCKER_RETRY_MS,
  AgentAwakePowerSaveBlocker
} from './agent-awake-power-save-blocker'

afterEach(() => {
  vi.useRealTimers()
})

describe('AgentAwakePowerSaveBlocker', () => {
  it('bounds unverifiable replacement candidates and cleans up both', () => {
    let nextId = 1
    let throwOnRead = false
    const live = new Set<number>()
    const blocker = {
      start: vi.fn(() => {
        const id = nextId++
        live.add(id)
        return id
      }),
      stop: vi.fn((id: number) => {
        live.delete(id)
      }),
      isStarted: vi.fn((id: number) => {
        if (throwOnRead) {
          throw new Error('power monitor unavailable')
        }
        return live.has(id)
      })
    }
    const assertion = new AgentAwakePowerSaveBlocker(blocker, {
      debug: vi.fn(),
      warn: vi.fn()
    })

    assertion.start('initial')
    throwOnRead = true
    assertion.start('retry')
    assertion.start('bounded-retry')

    expect(blocker.start).toHaveBeenCalledTimes(2)
    expect(live).toEqual(new Set([1, 2]))
    assertion.stop('cleanup')
    expect(live.size).toBe(0)
  })

  it('keeps prior coverage when an unverifiable replacement cannot start', () => {
    let failStart = false
    let throwOnRead = false
    const live = new Set<number>()
    const blocker = {
      start: vi.fn(() => {
        if (failStart) {
          throw new Error('start failed')
        }
        live.add(42)
        return 42
      }),
      stop: vi.fn((id: number) => {
        live.delete(id)
      }),
      isStarted: vi.fn((id: number) => {
        if (throwOnRead) {
          throw new Error('power monitor unavailable')
        }
        return live.has(id)
      })
    }
    const assertion = new AgentAwakePowerSaveBlocker(blocker, {
      debug: vi.fn(),
      warn: vi.fn()
    })

    assertion.start('initial')
    throwOnRead = true
    failStart = true
    assertion.start('retry')

    expect(blocker.start).toHaveBeenCalledTimes(2)
    expect(live).toEqual(new Set([42]))
    expect(blocker.stop).not.toHaveBeenCalled()

    throwOnRead = false
    failStart = false
    assertion.stop('cleanup')
    expect(live.size).toBe(0)
  })

  it('retires the prior id only after replacement coverage is confirmed', () => {
    let nextId = 1
    let oldUnverifiable = false
    const live = new Set<number>()
    const blocker = {
      start: vi.fn(() => {
        const id = nextId++
        live.add(id)
        return id
      }),
      stop: vi.fn((id: number) => {
        live.delete(id)
      }),
      isStarted: vi.fn((id: number) => {
        if (id === 1 && oldUnverifiable) {
          throw new Error('old id is unverifiable')
        }
        return live.has(id)
      })
    }
    const assertion = new AgentAwakePowerSaveBlocker(blocker, {
      debug: vi.fn(),
      warn: vi.fn()
    })

    assertion.start('initial')
    oldUnverifiable = true
    assertion.start('retry')

    expect(blocker.start).toHaveBeenCalledTimes(2)
    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(live).toEqual(new Set([2]))
    assertion.stop('cleanup')
    expect(live.size).toBe(0)
  })

  it('retains a new id when its post-start check is unverifiable', () => {
    let throwOnRead = true
    const blocker = {
      start: vi.fn(() => 42),
      stop: vi.fn(),
      isStarted: vi.fn(() => {
        if (throwOnRead) {
          throw new Error('power monitor unavailable')
        }
        return false
      })
    }
    const assertion = new AgentAwakePowerSaveBlocker(blocker, {
      debug: vi.fn(),
      warn: vi.fn()
    })

    assertion.start('initial')
    throwOnRead = false
    assertion.stop('cleanup')

    expect(blocker.stop).toHaveBeenCalledWith(42)
  })

  it('trusts a successful stop when status reads are unavailable', () => {
    let nextId = 1
    const blocker = {
      start: vi.fn(() => nextId++),
      stop: vi.fn(),
      isStarted: vi.fn(() => {
        throw new Error('power monitor unavailable')
      })
    }
    const assertion = new AgentAwakePowerSaveBlocker(blocker, {
      debug: vi.fn(),
      warn: vi.fn()
    })

    assertion.start('initial')
    assertion.stop('cleanup')
    assertion.start('later')

    expect(blocker.start).toHaveBeenCalledTimes(2)
    expect(blocker.stop).toHaveBeenCalledWith(1)
  })

  it('retains an unverifiable id after a failed stop so cleanup can retry', () => {
    let live = true
    let stopFails = true
    let throwOnRead = false
    const blocker = {
      start: vi.fn(() => 42),
      stop: vi.fn(() => {
        if (stopFails) {
          throw new Error('stop failed')
        }
        live = false
      }),
      isStarted: vi.fn(() => {
        if (throwOnRead) {
          throw new Error('power monitor unavailable')
        }
        return live
      })
    }
    const assertion = new AgentAwakePowerSaveBlocker(blocker, {
      debug: vi.fn(),
      warn: vi.fn()
    })

    assertion.start('initial')
    throwOnRead = true
    assertion.stop('first-cleanup')
    throwOnRead = false
    stopFails = false
    assertion.stop('retry-cleanup')

    expect(blocker.stop).toHaveBeenCalledTimes(2)
    expect(blocker.stop).toHaveBeenNthCalledWith(1, 42)
    expect(blocker.stop).toHaveBeenNthCalledWith(2, 42)
  })

  it('retries a failed initial start at a bounded cadence', () => {
    vi.useFakeTimers()
    let failStart = true
    const live = new Set<number>()
    const blocker = {
      start: vi.fn(() => {
        if (failStart) {
          throw new Error('start failed')
        }
        live.add(42)
        return 42
      }),
      stop: vi.fn((id: number) => {
        live.delete(id)
      }),
      isStarted: vi.fn((id: number) => live.has(id))
    }
    const assertion = new AgentAwakePowerSaveBlocker(blocker, {
      debug: vi.fn(),
      warn: vi.fn()
    })

    assertion.start('initial')
    failStart = false
    vi.advanceTimersByTime(AGENT_AWAKE_BLOCKER_RETRY_MS)

    expect(blocker.start).toHaveBeenCalledTimes(2)
    expect(live).toEqual(new Set([42]))
    assertion.stop('cleanup')
  })

  it('cancels a pending start retry when coverage is no longer desired', () => {
    vi.useFakeTimers()
    const blocker = {
      start: vi.fn(() => {
        throw new Error('start failed')
      }),
      stop: vi.fn(),
      isStarted: vi.fn(() => false)
    }
    const assertion = new AgentAwakePowerSaveBlocker(blocker, {
      debug: vi.fn(),
      warn: vi.fn()
    })

    assertion.start('initial')
    assertion.stop('disabled')
    vi.advanceTimersByTime(AGENT_AWAKE_BLOCKER_RETRY_MS * 2)

    expect(blocker.start).toHaveBeenCalledOnce()
  })
})
