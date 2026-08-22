import { runWslProcess } from './wsl/wsl-runner'
import { isSafeFishHistorySession } from './fish-history-session'

/** Deduped by distro+session, so a rescan that re-queues the same tombstone
 *  joins the running call instead of spawning a second `wsl.exe`.
 *
 *  Not otherwise rate-limited: the caller admits at most
 *  MAX_PENDING_HISTORY_TREE_REMOVALS tombstones at a time, so fanout is bounded
 *  but can still be dozens of `wsl.exe` launches during a startup GC drain on a
 *  machine with many dead WSL fish worktrees. Narrowing that belongs with the
 *  tombstone scheduler that owns the admission, not here. */
const cleanupsInFlight = new Map<string, Promise<void>>()

/** Why run this INSIDE the distro: the history file lives on the distro's own
 *  filesystem under its `$XDG_DATA_HOME`/`$HOME`, which only a shell in there
 *  can resolve. `string match -qr '^/'` rejects a relative XDG_DATA_HOME the
 *  same way fish itself does before falling back. */
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
  run: typeof runWslProcess = runWslProcess
): Promise<void> {
  if (!distro.trim() || !isSafeFishHistorySession(session)) {
    return Promise.resolve()
  }
  const key = `${distro}\0${session}`
  const existing = cleanupsInFlight.get(key)
  if (existing) {
    return existing
  }
  const cleanup = runCleanup(distro, session, run).finally(() => {
    cleanupsInFlight.delete(key)
  })
  cleanupsInFlight.set(key, cleanup)
  return cleanup
}

async function runCleanup(
  distro: string,
  session: string,
  run: typeof runWslProcess
): Promise<void> {
  const result = await run({
    distro,
    lane: 'probe',
    // The old `--exec fish` spawn never sourced a login shell either, so a
    // probe failure must run degraded rather than turn a working cleanup into
    // an error.
    allowDegradedEnvironment: true,
    program: 'fish',
    args: ['--command', fishCleanupScript(session)],
    timeoutMs: 5_000
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(
      `wsl fish history cleanup failed for ${distro}: code=${result.code} timedOut=${result.timedOut}`
    )
  }
}

/** Test-only: drop in-flight state so one test's pending work cannot reach the next. */
export function __resetWslFishHistoryCleanups(): void {
  cleanupsInFlight.clear()
}

/** Await every in-flight cleanup; for deterministic shutdown and tests.
 *  Why snapshot-and-drain rather than re-reading the map in the loop condition:
 *  an entry that has settled but whose `.finally` has not yet removed it would
 *  make `while (size > 0)` re-await a resolved promise forever, starving the
 *  event loop instead of returning. */
export async function flushWslFishHistoryCleanups(): Promise<void> {
  const awaited = new Set<Promise<void>>()
  let pending = [...cleanupsInFlight.values()]
  while (pending.length > 0) {
    for (const cleanup of pending) {
      awaited.add(cleanup)
    }
    await Promise.allSettled(pending)
    pending = [...cleanupsInFlight.values()].filter((cleanup) => !awaited.has(cleanup))
  }
}
