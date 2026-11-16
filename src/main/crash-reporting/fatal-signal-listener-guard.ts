/**
 * Signals raised by the faulting instruction itself. A JS listener on one (signal-exit, loaded by
 * proper-lockfile, adds SIGTRAP and SIGABRT) makes libuv's handler return to that instruction, so
 * Chromium's fatal OOM trap re-fires forever at full CPU instead of crashing with a report.
 * The listener itself never runs: the faulting thread never returns to the event loop.
 */
const SYNCHRONOUS_FAULT_SIGNALS: ReadonlySet<string | symbol> = new Set([
  'SIGTRAP',
  'SIGABRT',
  'SIGIOT',
  'SIGSYS',
  'SIGILL',
  'SIGBUS',
  'SIGFPE',
  'SIGSEGV'
])

const LISTENER_METHODS = [
  'on',
  'addListener',
  'once',
  'prependListener',
  'prependOnceListener'
] as const

type SignalListenerTarget = Pick<
  NodeJS.Process,
  (typeof LISTENER_METHODS)[number] | 'removeAllListeners'
>

/**
 * Refuses these listeners before Node starts libuv's handler, so the crash reporter's own handler
 * (Linux) or the default action stays in place. Once per process, before modules that add them.
 */
export function installFatalSignalListenerGuard(target: SignalListenerTarget = process): void {
  for (const signal of SYNCHRONOUS_FAULT_SIGNALS) {
    target.removeAllListeners(signal as string)
  }
  for (const method of LISTENER_METHODS) {
    const original = target[method] as (...args: unknown[]) => unknown
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same signature; the wrapper forwards every other event unchanged.
    target[method] = function (this: unknown, event: unknown, ...rest: unknown[]) {
      return SYNCHRONOUS_FAULT_SIGNALS.has(event as string | symbol)
        ? target
        : original.call(this, event, ...rest)
    } as SignalListenerTarget[typeof method]
  }
}
