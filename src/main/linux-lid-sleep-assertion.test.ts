import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  LINUX_LID_SLEEP_ASSERTION_RETRY_MS,
  LinuxLidSleepAssertion
} from './linux-lid-sleep-assertion'

class FakeSystemdInhibitProcess extends EventEmitter {
  pid = 123
  stdin = Object.assign(new EventEmitter(), { destroy: vi.fn() })
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
  it('holds sleep and lid-switch inhibitors with a parent-owned input pipe on Linux', () => {
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
        'cat'
      ],
      {
        stdio: ['pipe', 'ignore', 'ignore'],
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

  it('releases only its own inhibitor by closing the input pipe', () => {
    const child = new FakeSystemdInhibitProcess()
    const assertion = new LinuxLidSleepAssertion({
      logger: createLogger(),
      platform: 'linux',
      spawn: vi.fn(() => child)
    })

    assertion.start('status-change')
    assertion.stop('settings-change')

    expect(child.stdin.destroy).toHaveBeenCalledTimes(1)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('keeps late spawn errors handled until the stopped child closes', () => {
    const child = new FakeSystemdInhibitProcess()
    const assertion = new LinuxLidSleepAssertion({
      logger: createLogger(),
      platform: 'linux',
      spawn: vi.fn(() => child)
    })

    assertion.start('status-change')
    expect(child.listenerCount('error')).toBe(1)
    expect(child.listenerCount('exit')).toBe(1)

    assertion.stop('settings-change')

    expect(child.listenerCount('error')).toBe(1)
    child.emit('exit', 0, null)
    expect(child.listenerCount('error')).toBe(1)
    child.emit('close', 0, null)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
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
    child.emit('error', new Error('spawn failed after stop'))
    child.stdin.emit('error', new Error('pipe closed after stop'))

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
    firstChild.emit('close', -1, null)
    now += LINUX_LID_SLEEP_ASSERTION_RETRY_MS + 1
    assertion.start('status-change')

    expect(onUnexpectedFailure).toHaveBeenCalledWith('linux-lid-assertion-failure')
    expect(spawn).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(firstChild.listenerCount('error')).toBe(0)
    expect(firstChild.listenerCount('exit')).toBe(0)
    expect(firstChild.stdin.destroy).toHaveBeenCalledOnce()
  })

  it('releases the pipe after a child exits unexpectedly', () => {
    const child = new FakeSystemdInhibitProcess()
    const onUnexpectedFailure = vi.fn()
    const assertion = new LinuxLidSleepAssertion({
      logger: createLogger(),
      onUnexpectedFailure,
      platform: 'linux',
      spawn: vi.fn(() => child)
    })

    assertion.start('status-change')
    child.emit('exit', 1, null)

    expect(child.stdin.destroy).toHaveBeenCalledOnce()
    expect(onUnexpectedFailure).toHaveBeenCalledWith('linux-lid-assertion-failure')
    assertion.dispose()
  })

  it('handles pipe errors without crashing and permits a bounded retry', () => {
    const child = new FakeSystemdInhibitProcess()
    const replacement = new FakeSystemdInhibitProcess()
    const spawn = vi.fn(() => replacement).mockReturnValueOnce(child)
    const onUnexpectedFailure = vi.fn()
    let now = 1_000
    const assertion = new LinuxLidSleepAssertion({
      logger: createLogger(),
      now: () => now,
      onUnexpectedFailure,
      platform: 'linux',
      spawn
    })

    assertion.start('status-change')
    child.stdin.emit('error', new Error('pipe failed'))
    assertion.start('status-change')
    expect(spawn).toHaveBeenCalledOnce()
    expect(child.stdin.destroy).toHaveBeenCalledOnce()
    expect(onUnexpectedFailure).toHaveBeenCalledTimes(1)
    now += LINUX_LID_SLEEP_ASSERTION_RETRY_MS
    assertion.start('status-change')

    expect(spawn).toHaveBeenCalledTimes(2)
    assertion.dispose()
  })

  it.each([true, false])(
    'handles pipe then child errors until close (intentional stop: %s)',
    (stop) => {
      const child = new FakeSystemdInhibitProcess()
      const onUnexpectedFailure = vi.fn()
      const assertion = new LinuxLidSleepAssertion({
        logger: createLogger(),
        onUnexpectedFailure,
        platform: 'linux',
        spawn: vi.fn(() => child)
      })
      assertion.start('status-change')
      if (stop) {
        assertion.stop('settings-change')
      }

      child.stdin.emit('error', new Error('pipe failed'))
      expect(() => child.emit('error', new Error('late spawn failure'))).not.toThrow()
      child.emit('exit', 1, null)
      expect(onUnexpectedFailure).toHaveBeenCalledTimes(stop ? 0 : 1)
      child.emit('close', 1, null)
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('exit')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
      assertion.dispose()
    }
  )

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
