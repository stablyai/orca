import { describe, expect, it } from 'vitest'
import type { CustomTuiAgentId, DeletedCustomTuiAgent } from '../../shared/types'
import { pruneTombstones, type TombstoneReferenceCounter } from './agent-catalog-tombstone-gc'

const UUID_A = '01234567-89ab-4cde-8f01-23456789abcd'
const UUID_B = 'fedcba98-7654-4321-8fed-cba987654321'

function customId(base: string, uuid = UUID_A): CustomTuiAgentId {
  return `custom-agent:${base}:${uuid}` as CustomTuiAgentId
}

function sequentialId(index: number): CustomTuiAgentId {
  return customId('codex', `${index}`.padStart(8, '0') + UUID_A.slice(8))
}

function tombstonesFor(ids: readonly CustomTuiAgentId[]): DeletedCustomTuiAgent[] {
  return ids.map((id, index) => ({ id, baseAgent: 'codex', label: `T${index}`, deletedAt: index }))
}

type OwnerFixture = { referencedIds: readonly string[]; readable: boolean }

/** Pre-fix shape: one full owner sweep per tombstone. */
function perIdCounter(owners: readonly OwnerFixture[], sweeps: { count: number }) {
  return (id: CustomTuiAgentId): number | 'unknown' => {
    let total = 0
    for (const owner of owners) {
      sweeps.count += 1
      if (!owner.readable) {
        return 'unknown'
      }
      total += owner.referencedIds.filter((value) => value === id).length
    }
    return total
  }
}

/** Post-fix shape: owners indexed once, then a single pass over tombstones. */
function batchCounter(
  owners: readonly OwnerFixture[],
  sweeps: { count: number }
): TombstoneReferenceCounter {
  return {
    countForIds: (ids) => {
      const wanted = new Set<string>(ids)
      const matched = new Map<string, number>()
      let complete = true
      for (const owner of owners) {
        sweeps.count += 1
        if (!owner.readable) {
          complete = false
          continue
        }
        for (const value of owner.referencedIds) {
          if (wanted.has(value)) {
            matched.set(value, (matched.get(value) ?? 0) + 1)
          }
        }
      }
      const counts = new Map<CustomTuiAgentId, number | 'unknown'>()
      for (const id of ids) {
        counts.set(id, complete ? (matched.get(id) ?? 0) : 'unknown')
      }
      return counts
    }
  }
}

describe('pruneTombstones batch counting (P1-9)', () => {
  const unreferenced = customId('codex', UUID_A)
  const referencedOnce = customId('claude', UUID_B)
  const referencedTwice = customId('gemini', UUID_A)
  // Mixed: unreferenced (twice over, so a duplicate id is covered), single and
  // multi reference, plus owner values that match no tombstone.
  const mixed = [unreferenced, referencedOnce, referencedTwice, unreferenced]

  const owners: OwnerFixture[] = [
    { referencedIds: [referencedOnce, 'auto'], readable: true },
    { referencedIds: [], readable: true },
    { referencedIds: [referencedTwice, referencedTwice, 'claude'], readable: true }
  ]

  it('produces identical retain/prune decisions for both counter shapes', () => {
    const tombstones = tombstonesFor(mixed)
    const perId = pruneTombstones(tombstones, perIdCounter(owners, { count: 0 }))
    const batch = pruneTombstones(tombstones, batchCounter(owners, { count: 0 }))
    expect(batch).toEqual(perId)
    expect(perId.prunedIds).toEqual([unreferenced, unreferenced])
    expect(perId.retained.map((entry) => entry.id)).toEqual([referencedOnce, referencedTwice])
  })

  it('retains everything when an owner is unreadable, under both counter shapes', () => {
    const tombstones = tombstonesFor(mixed)
    const withFailure = [...owners, { referencedIds: [], readable: false }]
    const perId = pruneTombstones(tombstones, perIdCounter(withFailure, { count: 0 }))
    const batch = pruneTombstones(tombstones, batchCounter(withFailure, { count: 0 }))
    expect(batch).toEqual(perId)
    expect(perId.prunedIds).toEqual([])
    expect(perId.retained).toHaveLength(mixed.length)
  })

  it('retains a tombstone the counter omits rather than treating it as unreferenced', () => {
    const tombstones = tombstonesFor([unreferenced])
    const result = pruneTombstones(tombstones, { countForIds: () => new Map() })
    expect(result.prunedIds).toEqual([])
    expect(result.retained).toEqual(tombstones)
  })

  it('sweeps every owner once for the whole batch instead of once per tombstone', () => {
    const tombstones = tombstonesFor(Array.from({ length: 200 }, (_, index) => sequentialId(index)))
    const batchSweeps = { count: 0 }
    pruneTombstones(tombstones, batchCounter(owners, batchSweeps))
    expect(batchSweeps.count).toBe(owners.length)

    const perIdSweeps = { count: 0 }
    pruneTombstones(tombstones, perIdCounter(owners, perIdSweeps))
    expect(perIdSweeps.count).toBe(owners.length * tombstones.length)
  })

  it('stays linear on a 3,500-tombstone catalog', () => {
    const ids = Array.from({ length: 3500 }, (_, index) => sequentialId(index))
    const bigOwner: OwnerFixture[] = [{ referencedIds: ids.slice(0, 1750), readable: true }]
    const started = performance.now()
    const result = pruneTombstones(tombstonesFor(ids), batchCounter(bigOwner, { count: 0 }))
    expect(performance.now() - started).toBeLessThan(150)
    expect(result.prunedIds).toHaveLength(1750)
    expect(result.retained).toHaveLength(1750)
  })
})
