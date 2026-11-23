import type { EventEmitter } from 'node:events'

/**
 * Signals raised by the faulting instruction itself. A JS listener on one (signal-exit, loaded by
 * proper-lockfile, adds SIGTRAP and SIGABRT) makes libuv's handler return to that instruction, so
 * Chromium's fatal OOM trap re-fires forever at full CPU instead of crashing with a report.
 * The listener itself never runs: the faulting thread never returns to the event loop.
 */
const SYNCHRONOUS_FAULT_SIGNALS = [
  'SIGTRAP',
  'SIGABRT',
  'SIGIOT',
  'SIGSYS',
  'SIGILL',
  'SIGBUS',
  'SIGFPE',
  'SIGSEGV'
] as const
const FAULT_SIGNALS: ReadonlySet<unknown> = new Set(SYNCHRONOUS_FAULT_SIGNALS)

const LISTENER_METHODS = [
  'on',
  'addListener',
  'once',
  'prependListener',
  'prependOnceListener'
] as const

/**
 * Drops these listeners and refuses new ones before Node starts libuv's handler for them. Bundled
 * externals (proper-lockfile) load before entry code, so their listeners exist at install; dropping
 * them restores the default action, which the crash reporter started later still catches.
 */
export function installFatalSignalListenerGuard(target: EventEmitter = process): void {
  for (const signal of SYNCHRONOUS_FAULT_SIGNALS) {
    target.removeAllListeners(signal)
  }
  for (const method of LISTENER_METHODS) {
    const original = target[method]
    Object.defineProperty(target, method, {
      configurable: true,
      writable: true,
      value: function (
        this: EventEmitter,
        event: string | symbol,
        listener: (...args: unknown[]) => void
      ): EventEmitter {
        return FAULT_SIGNALS.has(event) ? this : original.call(this, event, listener)
      }
    })
  }
}
