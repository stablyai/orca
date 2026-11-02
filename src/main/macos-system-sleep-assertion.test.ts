import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  MACOS_SYSTEM_SLEEP_ASSERTION_RETRY_MS,
  MacosSystemSleepAssertion
} from './macos-system-sleep-assertion'

class FakeCaffeinateProcess extends EventEmitter {
  pid = 123
  kill = vi.fn(() => {
    this.emit('exit', null, 'SIGTERM')
    return true
  })
}

function createLogger() {
  return {
    debug: vi.fn(),
    warn: vi.fn()
  }
}

describe('MacosSystemSleepAssertion', () => {
  it('clears the child and notifies the owner on unexpected exit', () => {
    const firstChild = new FakeCaffeinateProcess()
    const secondChild = new FakeCaffeinateProcess()
    const spawn = vi.fn(() => firstChild).mockImplementationOnce(() => firstChild)
    spawn.mockImplementationOnce(() => secondChild)
    let now = 1_000
    const onUnexpectedFailure = vi.fn()
    const assertion = new MacosSystemSleepAssertion({
      logger: createLogger(),
      now: () => now,
      onUnexpectedFailure,
      platform: 'darwin',
      spawn
    })

    assertion.start('status-change')
    firstChild.emit('exit', 1, null)
    now += MACOS_SYSTEM_SLEEP_ASSERTION_RETRY_MS + 1
    assertion.start('status-change')

    expect(onUnexpectedFailure).toHaveBeenCalledWith('macos-assertion-failure')
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(firstChild.listenerCount('error')).toBe(0)
    expect(firstChild.listenerCount('exit')).toBe(0)
  })

  it('does not report an intentional stop as unexpected', () => {
    const child = new FakeCaffeinateProcess()
    const onUnexpectedFailure = vi.fn()
    const assertion = new MacosSystemSleepAssertion({
      logger: createLogger(),
      onUnexpectedFailure,
      platform: 'darwin',
      spawn: vi.fn(() => child)
    })

    assertion.start('status-change')
    assertion.stop('settings-change')

    expect(onUnexpectedFailure).not.toHaveBeenCalled()
  })

  it('suppresses retry attempts until the shared retry gate expires', () => {
    vi.useFakeTimers()
    let now = 1_000
    const spawn = vi.fn(() => {
      throw new Error('missing caffeinate')
    })
    const onUnexpectedFailure = vi.fn()
    const assertion = new MacosSystemSleepAssertion({
      logger: createLogger(),
      now: () => now,
      onUnexpectedFailure,
      platform: 'darwin',
      spawn
    })

    assertion.start('status-change')
    assertion.start('power-resume')
    assertion.start('stale-expiry')
    now += MACOS_SYSTEM_SLEEP_ASSERTION_RETRY_MS - 1
    vi.advanceTimersByTime(MACOS_SYSTEM_SLEEP_ASSERTION_RETRY_MS - 1)
    assertion.start('status-change')

    expect(spawn).toHaveBeenCalledTimes(1)

    now += 1
    vi.advanceTimersByTime(1)

    expect(onUnexpectedFailure).toHaveBeenCalledWith('macos-assertion-retry')
    assertion.start('macos-assertion-retry')

    expect(spawn).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
