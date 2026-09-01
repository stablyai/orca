// Unreferenced-tombstone GC shared by catalog mutations and the service's
// post-reference-removal prune. Pruning is conservative (authoritative zero
// references only) and must never resurrect a row the normalizer suppresses
// under a same-id tombstone.

import type {
  CustomTuiAgent,
  CustomTuiAgentId,
  DeletedCustomTuiAgent,
  GlobalSettings
} from '../../shared/types'
import type { AgentCatalog } from '../../shared/custom-tui-agents'
import type { TombstoneReferenceCount } from './agent-catalog-draft-validation'

/** Reference counter for a prune batch. The per-id function rescans every owner
 *  once per tombstone (quadratic once both grow); `countForIds` indexes the
 *  owners a single time and answers the whole batch from that pass. */
export type TombstoneReferenceCounter =
  | ((id: CustomTuiAgentId) => TombstoneReferenceCount)
  | {
      countForIds: (
        ids: readonly CustomTuiAgentId[]
      ) => ReadonlyMap<CustomTuiAgentId, TombstoneReferenceCount>
    }

function countTombstoneReferences(
  tombstones: readonly DeletedCustomTuiAgent[],
  counter: TombstoneReferenceCounter
): ReadonlyMap<CustomTuiAgentId, TombstoneReferenceCount> {
  const ids: CustomTuiAgentId[] = []
  const seen = new Set<CustomTuiAgentId>()
  for (const tombstone of tombstones) {
    if (!seen.has(tombstone.id)) {
      seen.add(tombstone.id)
      ids.push(tombstone.id)
    }
  }
  if (typeof counter !== 'function') {
    return counter.countForIds(ids)
  }
  const counts = new Map<CustomTuiAgentId, TombstoneReferenceCount>()
  for (const id of ids) {
    counts.set(id, counter(id))
  }
  return counts
}

/** Conservative unreferenced-tombstone prune: authoritative zero references
 *  frees the tombstone (and its label); 'unknown' retains. */
export function pruneTombstones(
  tombstones: readonly DeletedCustomTuiAgent[],
  countReferences: TombstoneReferenceCounter
): { retained: DeletedCustomTuiAgent[]; prunedIds: CustomTuiAgentId[] } {
  const counts = countTombstoneReferences(tombstones, countReferences)
  const retained: DeletedCustomTuiAgent[] = []
  const prunedIds: CustomTuiAgentId[] = []
  for (const tombstone of tombstones) {
    // A counter that omits an id is treated as unreadable, never as zero.
    if (counts.get(tombstone.id) === 0) {
      prunedIds.push(tombstone.id)
    } else {
      retained.push(tombstone)
    }
  }
  return { retained, prunedIds }
}

/** Normalization suppresses valid/repair-required rows under a same-id
 *  tombstone, so pruning that tombstone alone would resurrect the row (and the
 *  args/env deletion made unrecoverable). These rows must leave the persisted
 *  array in the same write that prunes their tombstone. Corrupt rows are
 *  excluded: they are visible for explicit repair, never suppressed. */
export function collectRowsSuppressedByPrunedTombstones(
  persistedLive: readonly unknown[],
  prunedIds: readonly CustomTuiAgentId[],
  catalog: AgentCatalog
): ReadonlySet<unknown> {
  const suppressed = new Set<unknown>()
  if (prunedIds.length === 0) {
    return suppressed
  }
  const pruned = new Set<string>(prunedIds)
  const corruptIndices = new Set(catalog.corruptRows.map((row) => row.physicalIndex))
  persistedLive.forEach((row, index) => {
    const id = (row as { id?: unknown } | null)?.id
    if (
      typeof id === 'string' &&
      pruned.has(id) &&
      // A malformed persisted tombstone never suppressed anything, so its
      // same-id row is visible and must not be stripped.
      catalog.tombstonesById.has(id as CustomTuiAgentId) &&
      !corruptIndices.has(index)
    ) {
      suppressed.add(row)
    }
  })
  return suppressed
}

/** Convenience for call sites that filter the same array the set was built
 *  from; repair mutations collect first and filter their edited copy instead. */
export function stripRowsSuppressedByPrunedTombstones(
  persistedLive: readonly unknown[],
  prunedIds: readonly CustomTuiAgentId[],
  catalog: AgentCatalog
): unknown[] {
  const suppressed = collectRowsSuppressedByPrunedTombstones(persistedLive, prunedIds, catalog)
  return persistedLive.filter((row) => !suppressed.has(row))
}

/** One-write prune patch (without the revision bump): retained tombstones plus,
 *  when a pruned tombstone suppressed a same-id persisted row, the stripped
 *  live array. Null when nothing prunes. */
export function buildUnreferencedTombstonePrunePatch(
  settings: GlobalSettings,
  catalog: AgentCatalog,
  countReferences: TombstoneReferenceCounter
): Partial<GlobalSettings> | null {
  const tombstones = Array.isArray(settings.deletedCustomTuiAgents)
    ? settings.deletedCustomTuiAgents
    : []
  const { retained, prunedIds } = pruneTombstones(tombstones, countReferences)
  if (prunedIds.length === 0) {
    return null
  }
  const patch: Partial<GlobalSettings> = { deletedCustomTuiAgents: retained }
  const persistedLive = Array.isArray(settings.customTuiAgents) ? settings.customTuiAgents : []
  const suppressed = collectRowsSuppressedByPrunedTombstones(persistedLive, prunedIds, catalog)
  if (suppressed.size > 0) {
    patch.customTuiAgents = persistedLive.filter((row) => !suppressed.has(row)) as CustomTuiAgent[]
  }
  return patch
}
