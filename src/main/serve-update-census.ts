import { hostScopeCensusIsComplete } from '../shared/runtime-listing-host-scope'
import type { RuntimeTerminalListResult } from '../shared/runtime-types'

export type ServeUpdateCensusResult =
  | { ok: true }
  | { ok: false; reason: 'liveness-unavailable' | 'incomplete-scope' | 'terminals-live' }

export type CensusCapableRuntime = {
  listTerminals: (
    worktreeSelector?: string,
    limit?: number,
    opts?: { requireFreshPtyLiveness?: boolean; includeVisualLayouts?: boolean }
  ) => Promise<RuntimeTerminalListResult>
}

/**
 * A restart kills every terminal and agent in the service's cgroup, so an install
 * may only proceed when the census proves nothing live is present. A failed or
 * incomplete census is treated as "live work may exist" and blocks the install —
 * loss of contact is never evidence of an empty floor.
 */
export async function runServeUpdateCensus(
  runtime: CensusCapableRuntime
): Promise<ServeUpdateCensusResult> {
  // Why the smallest valid limit: emptiness is decided by totalCount, not the page;
  // the call only needs to trigger the fresh-PTY-liveness sweep.
  const MIN_LIVENESS_LIMIT = 1
  let listing: RuntimeTerminalListResult
  try {
    listing = await runtime.listTerminals(undefined, MIN_LIVENESS_LIMIT, {
      requireFreshPtyLiveness: true,
      includeVisualLayouts: false
    })
  } catch {
    return { ok: false, reason: 'liveness-unavailable' }
  }
  if (!listing.hostScope || !hostScopeCensusIsComplete(listing.hostScope)) {
    return { ok: false, reason: 'incomplete-scope' }
  }
  if (listing.terminals.length > 0 || listing.totalCount > 0) {
    return { ok: false, reason: 'terminals-live' }
  }
  return { ok: true }
}
