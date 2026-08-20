/** Deadline for one retirement discovery scan. Generated create awaits it, so it has to be short
 *  enough that a stalled NFS/SMB/WSL listing degrades to "seed nothing" instead of a frozen create. */
export const RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS = 15_000

/** How long a failed scan stays failed, so a stalled mount is not re-probed on every create. */
export const RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS = 60_000

export type RetirementScanResult = {
  names: Set<string>
  /** False when a source was refused, so the partial answer must not be memoized as final. */
  complete: boolean
}

type BackfillScan = {
  /** Resolves with the discovered names, or rejects once the deadline lapses. */
  names: Promise<Set<string>>
  /** Monotonic ms this scan may be retried after; 0 while it is in flight or has succeeded. */
  retryAfter: number
  /** Its listing has not settled. Retrying now would stack a second one on the same mount. */
  outstanding: boolean
}

const scansByStore = new WeakMap<object, Map<string, BackfillScan>>()

/** Monotonic, like the WSL gate's own stuck timer: wall time misjudges a backoff across laptop
 *  sleep or an NTP step, either pinning a namespace in its failure memo or ending it early. */
function monotonicNow(): number {
  return performance.now()
}

function withScanDeadline(scan: Promise<unknown>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(`retirement backfill scan exceeded ${RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS}ms`)
      )
    }, RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS)
    timer.unref?.()
    void scan
      .then(
        () => resolve(),
        (error: unknown) => reject(error)
      )
      .finally(() => clearTimeout(timer))
  })
}

/** Memoizes the one-time retirement discovery scan per store and cwd namespace.
 *
 *  A complete success is kept for the process lifetime — a name never un-spends, so rescanning
 *  could only lose entries. A failure is not: the original cache held the scan Promise forever and
 *  its `readdir` had no deadline, so one stalled listing wedged this create and every later
 *  generated-name create for the namespace until Orca restarted.
 *
 *  The deadline abandons a listing, it cannot cancel one — an unabortable `readdir` keeps its libuv
 *  threadpool thread until the OS releases it, and that pool defaults to four. So a retry is only
 *  allowed once the previous listing has actually settled. Without that, each lapsed backoff stacks
 *  another stuck thread on the same wedged mount until the process loses filesystem access. Keeping
 *  the rule per namespace rather than process-wide is deliberate: a global budget lets one bad mount
 *  spend it on its own retries and starve every healthy repo. */
export function runRetirementBackfillScan(
  store: object,
  scanKey: string,
  scan: () => Promise<RetirementScanResult>
): Promise<Set<string>> {
  let storeScans = scansByStore.get(store)
  if (!storeScans) {
    storeScans = new Map()
    scansByStore.set(store, storeScans)
  }
  const cached = storeScans.get(scanKey)
  if (
    cached &&
    (cached.retryAfter === 0 || cached.outstanding || monotonicNow() < cached.retryAfter)
  ) {
    return cached.names
  }
  const entry: BackfillScan = {
    names: Promise.resolve(new Set()),
    retryAfter: 0,
    outstanding: true
  }
  const started = scan()
  void started.then(
    (result) => {
      entry.outstanding = false
      // A listing that lands after the deadline still holds the right answer, and under WSL gate
      // contention that is the common case rather than the edge one — the gate admits a single
      // scan at a time and gives it 60s, four times this deadline. Dropping it would leave the
      // namespace unseeded on exactly the mounts this feature exists to cover. No liveness check
      // is needed: once a retry replaces this entry nothing can read it again, so the write is
      // inert.
      if (entry.retryAfter !== 0) {
        entry.names = Promise.resolve(result.names)
        entry.retryAfter = result.complete
          ? 0
          : monotonicNow() + RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS
      }
    },
    () => {
      entry.outstanding = false
    }
  )
  entry.names = withScanDeadline(started)
    .then(async () => {
      const result = await started
      // A refused source means names are missing. Serve what was found — under-retiring is the
      // direction that leaks — but leave the entry retryable instead of memoizing the hole.
      entry.retryAfter = result.complete
        ? 0
        : monotonicNow() + RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS
      return result.names
    })
    .catch((error: unknown) => {
      entry.retryAfter = monotonicNow() + RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS
      throw error
    })
  storeScans.set(scanKey, entry)
  return entry.names
}
