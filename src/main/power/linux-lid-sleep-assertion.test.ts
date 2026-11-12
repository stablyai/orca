import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { LinuxLidSleepAssertion } from './linux-lid-sleep-assertion'

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
})
