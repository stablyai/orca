// Ask for the gone-sandbox prune now instead of at the next 10-minute relist (LC-2). A sandbox
// deleted elsewhere (Home, another desktop, the CLI, the control plane) otherwise kept its row as
// "Orca Cloud · Couldn't start" until then, or for good when the app didn't stay open that long.
// The prune itself still needs proof: a list miss plus one confirming read (not found/destroyed).

const MIN_INTERVAL_MS = 30_000

let runner: (() => Promise<void>) | null = null
let lastRequestAt = Number.NEGATIVE_INFINITY
let running: Promise<void> | null = null

/** hosted-sandbox-install registers the forced backfill + prune pass. */
export function setCloudGonePruneRunner(next: (() => Promise<void>) | null): void {
  runner = next
  lastRequestAt = Number.NEGATIVE_INFINITY
}

/** A cloud list refreshed, or a sandbox read said not found: prune soon (throttled, single-flight). */
export function requestCloudGonePrune(now: number = Date.now()): Promise<void> {
  if (!runner || running || now - lastRequestAt < MIN_INTERVAL_MS) {
    return running ?? Promise.resolve()
  }
  lastRequestAt = now
  const run = runner
  running = run()
    .catch((error: unknown) => console.warn('[orca-cloud] gone-sandbox prune failed', error))
    .finally(() => {
      running = null
    })
  return running
}
