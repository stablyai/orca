// Authoritative reference index over every persisted owner of an agent
// reference. Tombstones are reference-counted recovery records: one is pruned
// only after an authoritative recheck proves zero references in every owner
// store, and an unavailable/corrupt owner store means "retain". Owners added by
// later feature units (worktree pending launches, background attempts,
// orchestration dispatches, sleeping sessions) register additional scanners
// here rather than growing a parallel index.
//
// Scanners enumerate the RAW referenced ids they hold; the index applies the
// counting policy. Tombstone GC and "Review references" count a specific custom
// id (built-ins are never tombstoned); base-disable impact (§973) counts a
// caller-supplied matcher (a base plus its derivatives). Keeping the filter here
// lets one scan answer both without each owner knowing either policy.

import type { CustomTuiAgentId } from '../../shared/types'
import type {
  AgentReferenceOwnerKind,
  AgentReferenceSummary
} from '../../shared/agent-reference-snapshot'

export type { AgentReferenceSummary }

export type AgentReferenceScanResult =
  | { ok: true; referencedIds: readonly unknown[] }
  | { ok: false }

export type AgentReferenceOwnerScanner = {
  owner: AgentReferenceOwnerKind
  /** Return every id this owner store currently references (raw, unfiltered), or
   *  ok:false when the store cannot be read (conservative retain). Never throw. */
  scan: () => AgentReferenceScanResult
}

/** Partial count under a matcher: `count` sums readable owners; `complete` is
 *  false when any (non-excluded) owner store could not be read, so the true
 *  total may be higher. */
export type MatchingReferenceCount = { count: number; complete: boolean }

export class AgentTombstoneReferenceIndex {
  private readonly scanners: AgentReferenceOwnerScanner[] = []

  register(scanner: AgentReferenceOwnerScanner): void {
    this.scanners.push(scanner)
  }

  /** Authoritative recheck across every registered owner for a single custom id.
   *  Returns 'unknown' when any owner scan fails, which callers must treat as
   *  "retain" (tombstone GC semantics — a partial count must never prune). */
  countReferences(id: CustomTuiAgentId): number | 'unknown' {
    let total = 0
    for (const scanner of this.scanners) {
      const result = scanner.scan()
      if (!result.ok) {
        return 'unknown'
      }
      total += countMatches(result.referencedIds, (value) => value === id)
    }
    return total
  }

  /** Per-owner counts for delete confirmation and "Review references". Owners
   *  whose scan failed report count -1 so the UI can say "unknown". */
  summarizeReferences(id: CustomTuiAgentId): AgentReferenceSummary[] {
    const byOwner = new Map<AgentReferenceOwnerScanner['owner'], number>()
    for (const scanner of this.scanners) {
      const result = scanner.scan()
      if (!result.ok) {
        byOwner.set(scanner.owner, -1)
        continue
      }
      const count = countMatches(result.referencedIds, (value) => value === id)
      const existing = byOwner.get(scanner.owner)
      if (existing === -1) {
        continue
      }
      byOwner.set(scanner.owner, (existing ?? 0) + count)
    }
    const summaries: AgentReferenceSummary[] = []
    for (const [owner, count] of byOwner) {
      if (count !== 0) {
        summaries.push({ owner, count })
      }
    }
    return summaries
  }

  /** Count references matching an arbitrary predicate — the base-disable impact
   *  path (§973), where `matches` accepts the base id and any of its derivatives.
   *  Unlike `countReferences`, an unreadable owner does NOT collapse the whole
   *  result: it returns the readable partial plus `complete: false` so the caller
   *  can render "at least N". `excludeOwners` skips owners counted separately
   *  (the caller reports sessions via the record store's base count instead). */
  countMatchingReferences(
    matches: (value: unknown) => boolean,
    options?: { excludeOwners?: ReadonlySet<AgentReferenceOwnerKind> }
  ): MatchingReferenceCount {
    let count = 0
    let complete = true
    for (const scanner of this.scanners) {
      if (options?.excludeOwners?.has(scanner.owner)) {
        continue
      }
      const result = scanner.scan()
      if (!result.ok) {
        complete = false
        continue
      }
      count += countMatches(result.referencedIds, matches)
    }
    return { count, complete }
  }
}

function countMatches(values: readonly unknown[], matches: (value: unknown) => boolean): number {
  let count = 0
  for (const value of values) {
    if (matches(value)) {
      count += 1
    }
  }
  return count
}
