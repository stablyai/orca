import type { HostCatalogEntry, HostProfile } from './types'

export type HostListSnapshot = {
  catalog: HostCatalogEntry[]
  profiles: HostProfile[]
}

// Share slow keychain reads until durable writes invalidate them (#8791).
let inflight: Promise<HostListSnapshot> | null = null
let revision = 0

export function getHostListLoadRevision(): number {
  return revision
}

export function shareHostListLoad(
  load: () => Promise<HostListSnapshot>
): Promise<HostListSnapshot> {
  if (inflight) {
    return inflight
  }
  const started = load().finally(() => {
    // Retire only this pass; an older completion must not discard its replacement.
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
