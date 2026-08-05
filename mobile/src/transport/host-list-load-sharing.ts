import type { HostProfile } from './types'

// Why: concurrent callers share a slow Keychain pass; durable writes invalidate
// it so later loads cannot receive stale snapshots (#8791).
let inflight: Promise<HostProfile[]> | null = null
let revision = 0

export function getHostListLoadRevision(): number {
  return revision
}

export function shareHostListLoad(load: () => Promise<HostProfile[]>): Promise<HostProfile[]> {
  if (inflight) {
    return inflight
  }
  const started = load().finally(() => {
    // Why: a dropped pass can settle after its replacement started; only retire
    // the entry still on offer, or the replacement is silently discarded.
    if (inflight === started) {
      inflight = null
    }
  })
  inflight = started
  return started
}

/** Call after every durable host write so no later read is served a pre-write pass. */
export function dropSharedHostListLoad(): void {
  revision += 1
  inflight = null
}
