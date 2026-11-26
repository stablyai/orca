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

export const listTargetsVerboseArgs: readonly string[] = ['list', 'targets', '-v']

// `hdc tconn <key> -remove` drops a daemon-side target registration.
export function removeTargetArgs(connectKey: string): string[] {
  return ['tconn', connectKey, '-remove']
}

export type HdcTargetState = 'connected' | 'offline' | 'other'
export type HdcVerboseTarget = { connectKey: string; state: HdcTargetState }

/**
 * Parses `hdc list targets -v`, whose plain sibling hides Offline registrations. Observed columns
 * (tab/space separated): `127.0.0.1:10000  TCP  Offline  unknown...  hdc`.
 */
export function parseHdcVerboseTargets(stdout: string): HdcVerboseTarget[] {
  const targets: HdcVerboseTarget[] = []
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('[')) {
      continue
    }
    const columns = line.split(/\s+/)
    const connectKey = columns[0]
    if (!connectKey || !connectKey.includes(':')) {
      continue
    }
    const stateToken = columns[2]?.toLowerCase()
    targets.push({
      connectKey,
      state:
        stateToken === 'connected' ? 'connected' : stateToken === 'offline' ? 'offline' : 'other'
    })
  }
  return targets
}

// A crashed emulator leaves its loopback registration stuck Offline; only local targets are safe
// to prune — USB/Wi-Fi devices must never be removed on our say-so.
export function offlineLocalConnectKeys(targets: readonly HdcVerboseTarget[]): string[] {
  return targets
    .filter((target) => target.state === 'offline' && isLocalEmulatorTarget(target.connectKey))
    .map((target) => target.connectKey)
}

// A local emulator connectKey is an IPv4 loopback address; USB/Wi-Fi devices are not.
export function isLocalEmulatorTarget(connectKey: string): boolean {
  return /^127\.0\.0\.1:\d+$/.test(connectKey)
}
