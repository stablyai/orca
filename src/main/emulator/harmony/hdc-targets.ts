// Pure parsing/arg-building for hdc targets. No process execution: the caller
// prepends the resolved hdc binary path to every arg array.

export const listTargetsArgs: readonly string[] = ['list', 'targets']

/**
 * Parses `hdc list targets` stdout: one connectKey (e.g. `127.0.0.1:5555` or a
 * USB serial) per line. hdc prints `[Empty]` with no targets and may print
 * `[Info:...]` status lines, so bracketed lines and blank lines are skipped.
 */
export function parseHdcTargets(stdout: string): string[] {
  const targets: string[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('[')) {
      continue
    }
    // A line may carry trailing status tokens; the connectKey is whitespace-free.
    const connectKey = line.split(/\s+/)[0]
    if (connectKey) {
      targets.push(connectKey)
    }
  }
  return targets
}

// Prefixes args with `-t <connectKey>` so hdc addresses one specific target.
export function hdcTargetArgs(connectKey: string, args: readonly string[]): string[] {
  return ['-t', connectKey, ...args]
}

// A local emulator connectKey is an IPv4 loopback address; USB/Wi-Fi devices are not.
export function isLocalEmulatorTarget(connectKey: string): boolean {
  return /^127\.0\.0\.1:\d+$/.test(connectKey)
}
