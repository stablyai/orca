import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installFatalSignalListenerGuard } from './fatal-signal-listener-guard'

const require = createRequire(import.meta.url)
const loader = require.resolve('tsx/cjs')
const guard = resolve('src/main/crash-reporting/fatal-signal-listener-guard.ts')

/**
 * A real process with the shipped proper-lockfile (signal-exit). A listener is the hang's
 * precondition: when the trap is the thread's own instruction, its JS handler never runs. A raised
 * SIGTRAP lets the loop run, so the exit alone can't tell; the listener count does.
 */
function trapWithShippedLockfile(order: 'guard-first' | 'lockfile-first'): {
  signal: NodeJS.Signals | null
  listeners: { trap: number; term: number }
} {
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `require(${JSON.stringify(loader)})
      const { installFatalSignalListenerGuard } = require(${JSON.stringify(guard)})
      if (process.argv[1] === 'guard-first') installFatalSignalListenerGuard()
      require('proper-lockfile')
      if (process.argv[1] === 'lockfile-first') installFatalSignalListenerGuard()
      process.stdout.write(JSON.stringify({
        trap: process.listenerCount('SIGTRAP'),
        term: process.listenerCount('SIGTERM')
      }))
      process.kill(process.pid, 'SIGTRAP')
      setTimeout(() => process.exit(0), 2000)`,
      order
    ],
    { encoding: 'utf8', timeout: 20_000 }
  )
  return { signal: child.signal, listeners: JSON.parse(child.stdout) }
}

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

  // Windows has no SIGTRAP to raise; the listener guard itself is covered above.
  it.skipIf(process.platform === 'win32').each(['guard-first', 'lockfile-first'] as const)(
    'proper-lockfile leaves no SIGTRAP listener, keeps its SIGTERM cleanup, and SIGTRAP kills (%s)',
    (order) => {
      const { signal, listeners } = trapWithShippedLockfile(order)
      expect(listeners).toEqual({ trap: 0, term: 1 })
      expect(signal).toBe('SIGTRAP')
    }
  )
})
