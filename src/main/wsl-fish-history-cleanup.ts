import { runWslProcess } from './wsl/wsl-runner'
import { isSafeFishHistorySession } from './fish-history-session'
import { isWslDistroRunning } from './wsl-background-distro-gate'

/** Stopped distros must wait for a later cleanup; GC cannot boot them. */
export type WslFishHistoryCleanupOutcome = 'deleted' | 'skipped' | 'distro-stopped'

/** Join identical cleanups; the tombstone scheduler bounds concurrency across different sessions. */
const cleanupsInFlight = new Map<string, Promise<WslFishHistoryCleanupOutcome>>()

/** Resolve data home inside the distro, rejecting relative XDG_DATA_HOME as fish does. */
function fishCleanupScript(session: string): string {
  return [
    'set -l data_home $XDG_DATA_HOME',
    'string match -qr "^/" -- $data_home; or set data_home "$HOME/.local/share"',
    `command rm -f -- "$data_home/fish/${session}_history"`
  ].join('; ')
}

export function deleteWslFishHistoryFile(
  distro: string,
  session: string,
  run: typeof runWslProcess = runWslProcess,
  isRunning: (distro: string) => Promise<boolean> = isWslDistroRunning
): Promise<WslFishHistoryCleanupOutcome> {
  if (!distro.trim() || !isSafeFishHistorySession(session)) {
    return Promise.resolve('skipped')
  }
  const key = `${distro}\0${session}`
  const existing = cleanupsInFlight.get(key)
  if (existing) {
    return existing
  }
  const cleanup = runCleanup(distro, session, run, isRunning).finally(() => {
    cleanupsInFlight.delete(key)
  })
  cleanupsInFlight.set(key, cleanup)
  return cleanup
}

async function runCleanup(
  distro: string,
  session: string,
  run: typeof runWslProcess,
  isRunning: (distro: string) => Promise<boolean>
): Promise<WslFishHistoryCleanupOutcome> {
  if (!(await isRunning(distro))) {
    return 'distro-stopped'
  }
  const result = await run({
    distro,
    // Prefer login PATH for fish installed by linuxbrew/nix, but permit the default PATH if probing fails.
    loginPath: 'preferred',
    program: 'fish',
    args: ['--command', fishCleanupScript(session)],
    timeoutMs: 5_000
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `wsl fish history cleanup failed for ${distro}: code=${result.code} timedOut=${result.timedOut}`
    )
  }
  return 'deleted'
}

export function __resetWslFishHistoryCleanups(): void {
  cleanupsInFlight.clear()
}

/** Await each cleanup once so settled entries awaiting finally removal cannot starve the event loop. */
export async function flushWslFishHistoryCleanups(): Promise<void> {
  const awaited = new Set<Promise<WslFishHistoryCleanupOutcome>>()
  let pending = [...cleanupsInFlight.values()]
  while (pending.length > 0) {
    for (const cleanup of pending) {
      awaited.add(cleanup)
    }
    await Promise.allSettled(pending)
    pending = [...cleanupsInFlight.values()].filter((cleanup) => !awaited.has(cleanup))
  }
}
