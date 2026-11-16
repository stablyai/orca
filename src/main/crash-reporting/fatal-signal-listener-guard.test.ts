import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { installFatalSignalListenerGuard } from './fatal-signal-listener-guard'

describe('installFatalSignalListenerGuard', () => {
  it('never holds a fault-signal listener, before or after install, keeping others', () => {
    const target = new EventEmitter()
    const noop = (): void => {}
    target.on('SIGABRT', noop)
    installFatalSignalListenerGuard(target)
    // What signal-exit registers when proper-lockfile loads, through every registration API.
    target.on('SIGTRAP', noop)
    target.addListener('SIGABRT', noop)
    target.once('SIGIOT', noop)
    target.prependListener('SIGSYS', noop)
    target.prependOnceListener('SIGSEGV', noop)
    target.on('SIGTERM', noop)
    target.once('SIGINT', noop)

    for (const signal of ['SIGTRAP', 'SIGABRT', 'SIGIOT', 'SIGSYS', 'SIGSEGV']) {
      expect(target.listenerCount(signal)).toBe(0)
    }
    expect(target.listenerCount('SIGTERM')).toBe(1)
    expect(target.listenerCount('SIGINT')).toBe(1)
  })
})
