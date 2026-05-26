import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  LINUX_LID_SLEEP_ASSERTION_RETRY_MS,
  LinuxLidSleepAssertion
} from './linux-lid-sleep-assertion'

class FakeSystemdInhibitProcess extends EventEmitter {
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

describe('LinuxLidSleepAssertion', () => {
  it('spawns systemd-inhibit with sleep and lid-switch inhibitors on Linux', () => {
    const child = new FakeSystemdInhibitProcess()
    const spawn = vi.fn(() => child)
    const assertion = new LinuxLidSleepAssertion({
      logger: createLogger(),
      platform: 'linux',
      spawn
    })

    assertion.start('status-change')

    expect(spawn).toHaveBeenCalledWith(
      'systemd-inhibit',
      [
        '--what=sleep:handle-lid-switch',
        '--who=Orca',
        '--why=Agents are working',
        '--mode=block',
        'sleep',
        'infinity'
      ],
      {
        stdio: 'ignore',
        windowsHide: true
      }
    )
  })

  it('is a no-op off Linux', () => {
    const spawn = vi.fn(() => new FakeSystemdInhibitProcess())
    const assertion = new LinuxLidSleepAssertion({
      logger: createLogger(),
      platform: 'darwin',
      spawn
    })

    assertion.start('status-change')

    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not start a second inhibitor while one is live', () => {
    const spawn = vi.fn(() => new FakeSystemdInhibitProcess())
    const assertion = new LinuxLidSleepAssertion({
      logger: createLogger(),
      platform: 'linux',
      spawn
    })

    assertion.start('status-change')
    assertion.start('power-resume')

    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('stops only the child process it started', () => {
    const child = new FakeSystemdInhibitProcess()
    const assertion = new LinuxLidSleepAssertion({
      logger: createLogger(),
      platform: 'linux',
      spawn: vi.fn(() => child)
    })

    assertion.start('status-change')
    assertion.stop('settings-change')

    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('does not report an intentional stop as a failed inhibitor', () => {
    const logger = createLogger()
    const child = new FakeSystemdInhibitProcess()
    const assertion = new LinuxLidSleepAssertion({
      logger,
      platform: 'linux',
      spawn: vi.fn(() => child)
    })

    assertion.start('status-change')
    assertion.stop('settings-change')

    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it('logs missing systemd-inhibit once and degrades to no-op starts', () => {
    const logger = createLogger()
    const spawn = vi.fn(() => {
      const error = new Error('spawn systemd-inhibit ENOENT') as Error & { code: string }
      error.code = 'ENOENT'
      throw error
    })
    const assertion = new LinuxLidSleepAssertion({
      logger,
      platform: 'linux',
      spawn
    })

    assertion.start('status-change')
    assertion.start('power-resume')

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.debug).not.toHaveBeenCalled()
  })

  it('clears the child and notifies the owner after a permission or DBus error', () => {
    const firstChild = new FakeSystemdInhibitProcess()
    const secondChild = new FakeSystemdInhibitProcess()
    const spawn = vi.fn(() => firstChild).mockImplementationOnce(() => firstChild)
    spawn.mockImplementationOnce(() => secondChild)
    const logger = createLogger()
    let now = 1_000
    const onUnexpectedFailure = vi.fn()
    const assertion = new LinuxLidSleepAssertion({
      logger,
      now: () => now,
      onUnexpectedFailure,
      platform: 'linux',
      spawn
    })

    assertion.start('status-change')
    const error = new Error('Access denied') as Error & { code: string }
    error.code = 'EACCES'
    firstChild.emit('error', error)
    now += LINUX_LID_SLEEP_ASSERTION_RETRY_MS + 1
    assertion.start('status-change')

    expect(onUnexpectedFailure).toHaveBeenCalledWith('linux-lid-assertion-failure')
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('suppresses retry attempts until the shared retry gate expires', () => {
    vi.useFakeTimers()
    let now = 1_000
    const spawn = vi.fn(() => {
      throw new Error('dbus unavailable')
    })
    const onUnexpectedFailure = vi.fn()
    const assertion = new LinuxLidSleepAssertion({
      logger: createLogger(),
      now: () => now,
      onUnexpectedFailure,
      platform: 'linux',
      spawn
    })

    assertion.start('status-change')
    assertion.start('power-resume')
    now += LINUX_LID_SLEEP_ASSERTION_RETRY_MS - 1
    vi.advanceTimersByTime(LINUX_LID_SLEEP_ASSERTION_RETRY_MS - 1)
    assertion.start('status-change')

    expect(spawn).toHaveBeenCalledTimes(1)

    now += 1
    vi.advanceTimersByTime(1)

    expect(onUnexpectedFailure).toHaveBeenCalledWith('linux-lid-assertion-retry')
    assertion.start('linux-lid-assertion-retry')

    expect(spawn).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('does not retry when systemd-inhibit is missing', () => {
    vi.useFakeTimers()
    const spawn = vi.fn(() => {
      const error = new Error('spawn systemd-inhibit ENOENT') as Error & { code: string }
      error.code = 'ENOENT'
      throw error
    })
    const onUnexpectedFailure = vi.fn()
    const assertion = new LinuxLidSleepAssertion({
      logger: createLogger(),
      onUnexpectedFailure,
      platform: 'linux',
      spawn
    })

    assertion.start('status-change')
    vi.advanceTimersByTime(LINUX_LID_SLEEP_ASSERTION_RETRY_MS)
    assertion.start('power-resume')

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(onUnexpectedFailure).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('logs repeated identical failures at debug until reset', () => {
    const logger = createLogger()
    const spawn = vi.fn(() => {
      throw new Error('dbus unavailable')
    })
    let now = 1_000
    const assertion = new LinuxLidSleepAssertion({
      logger,
      now: () => now,
      platform: 'linux',
      spawn
    })

    assertion.start('status-change')
    now += LINUX_LID_SLEEP_ASSERTION_RETRY_MS + 1
    assertion.start('power-resume')
    assertion.stop('settings-change')
    assertion.start('status-change')

    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.debug).toHaveBeenCalledTimes(1)
  })
})
