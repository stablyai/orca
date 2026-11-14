/** Bound generated-create waits on stalled NFS/SMB/WSL discovery. */
export const RETIREMENT_BACKFILL_SCAN_TIMEOUT_MS = 15_000

/** Back off failed mounts instead of probing on every create. */
export const RETIREMENT_BACKFILL_RETRY_AFTER_FAILURE_MS = 60_000

export type RetirementScanResult = {
  names: Set<string>
  /** False when a source was refused, so the partial answer must not be memoized as final. */
  complete: boolean
}

type BackfillScan = {
  names: Promise<Set<string>>
  /** Monotonic ms this scan may be retried after; 0 while it is in flight or has succeeded. */
  retryAfter: number
  /** Its listing has not settled. Retrying now would stack a second one on the same mount. */
  outstanding: boolean
}

const scansByStore = new WeakMap<WeakKey, Map<string, BackfillScan>>()

/** Wall-clock changes must not distort retry backoff. */
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

/** Keep complete scans; retry per namespace only after the prior listing settles, since deadlines cannot cancel readdir. */
export function runRetirementBackfillScan(
  store: WeakKey,
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
      // Retain valid late answers; WSL admission can delay a scan beyond this deadline.
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
      // Return partial names but keep missing sources retryable; caching the hole could reissue a used path.
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
