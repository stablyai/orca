const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error', 'debug'] as const
const INSTALLED = Symbol.for('orca.mainConsoleTimestamps')

type TimestampedConsole = Pick<Console, (typeof CONSOLE_LEVELS)[number]> & {
  [INSTALLED]?: true
}

/** Headless hosts have no other clock on main-process lines, so incidents cannot be lined up with daemon and kernel logs. */
export function installMainConsoleTimestamps(
  target: TimestampedConsole = console,
  now: () => Date = () => new Date()
): void {
  if (target[INSTALLED]) {
    return
  }
  target[INSTALLED] = true
  for (const level of CONSOLE_LEVELS) {
    const original = target[level].bind(target)
    target[level] = (...args: unknown[]): void => {
      const stamp = now().toISOString()
      // Joining into a leading string keeps its %s/%o format directives working.
      if (typeof args[0] === 'string') {
        original(`${stamp} ${args[0]}`, ...args.slice(1))
        return
      }
      original(stamp, ...args)
    }
  }
}
