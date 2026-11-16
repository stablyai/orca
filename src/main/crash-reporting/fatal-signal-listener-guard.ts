/**
 * Signals raised by the faulting instruction itself. A JS listener on one (signal-exit, loaded by
 * proper-lockfile, adds SIGTRAP and SIGABRT) makes libuv's handler return to that instruction, so
 * Chromium's fatal OOM trap re-fires forever at full CPU instead of crashing with a report.
 * The listener itself never runs: the faulting thread never returns to the event loop.
 */
const SYNCHRONOUS_FAULT_SIGNALS: ReadonlySet<string> = new Set([
  'SIGTRAP',
  'SIGABRT',
  'SIGIOT',
  'SIGSYS',
  'SIGILL',
  'SIGBUS',
  'SIGFPE',
  'SIGSEGV'
])

type SignalListenerTarget = Pick<
  NodeJS.Process,
  'on' | 'removeAllListeners' | 'removeListener'
>

export function installFatalSignalListenerGuard(target: SignalListenerTarget = process): void {
  for (const signal of SYNCHRONOUS_FAULT_SIGNALS) {
    target.removeAllListeners(signal)
  }
  target.on('newListener', (event: string | symbol, listener: (...args: unknown[]) => void) => {
    if (typeof event === 'string' && SYNCHRONOUS_FAULT_SIGNALS.has(event)) {
      // The listener is attached only after 'newListener' returns.
      queueMicrotask(() => target.removeListener(event, listener))
    }
  })
}
