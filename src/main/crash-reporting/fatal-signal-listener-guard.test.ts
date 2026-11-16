import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { installFatalSignalListenerGuard } from './fatal-signal-listener-guard'

describe('installFatalSignalListenerGuard', () => {
  it('drops fault-signal listeners added before and after install, keeping others', async () => {
    const target = new EventEmitter() as unknown as NodeJS.Process
    const noop = (): void => {}
    target.on('SIGABRT', noop)
    installFatalSignalListenerGuard(target)
    // What signal-exit registers when proper-lockfile loads.
    for (const signal of ['SIGTRAP', 'SIGABRT', 'SIGIOT', 'SIGSYS', 'SIGTERM', 'SIGINT']) {
      target.on(signal, noop)
    }
    await Promise.resolve()

    expect(target.listenerCount('SIGTRAP')).toBe(0)
    expect(target.listenerCount('SIGABRT')).toBe(0)
    expect(target.listenerCount('SIGIOT')).toBe(0)
    expect(target.listenerCount('SIGSYS')).toBe(0)
    expect(target.listenerCount('SIGTERM')).toBe(1)
    expect(target.listenerCount('SIGINT')).toBe(1)
  })
})
