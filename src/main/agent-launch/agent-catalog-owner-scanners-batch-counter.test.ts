import { describe, expect, it } from 'vitest'
import type { CustomTuiAgentId } from '../../shared/types'
import { AgentTombstoneReferenceIndex } from './agent-tombstone-reference-index'
import { createBatchTombstoneReferenceCounter } from './agent-catalog-owner-scanners'

const idA = 'custom-agent:codex:fedcba98-7654-4321-8fed-cba987654321' as CustomTuiAgentId
const idB = 'custom-agent:claude:01234567-89ab-4cde-8f01-23456789abcd' as CustomTuiAgentId
const idC = 'custom-agent:gemini:01234567-89ab-4cde-8f01-23456789abce' as CustomTuiAgentId

function countForIds(
  index: AgentTombstoneReferenceIndex,
  ids: readonly CustomTuiAgentId[]
): ReadonlyMap<CustomTuiAgentId, number | 'unknown'> {
  const counter = createBatchTombstoneReferenceCounter(index)
  if (typeof counter === 'function') {
    throw new Error('expected a batch counter')
  }
  return counter.countForIds(ids)
}

describe('createBatchTombstoneReferenceCounter', () => {
  it('matches per-id countReferences for every id in one owner pass', () => {
    const index = new AgentTombstoneReferenceIndex()
    let scans = 0
    index.register({
      owner: 'automation',
      scan: () => {
        scans += 1
        return { ok: true, referencedIds: [idA, idA, 'auto', null] }
      }
    })
    index.register({
      owner: 'workspace',
      scan: () => {
        scans += 1
        return { ok: true, referencedIds: [idB] }
      }
    })

    const batch = countForIds(index, [idA, idB, idC])
    expect(scans).toBe(2)
    expect([...batch]).toEqual([
      [idA, index.countReferences(idA)],
      [idB, index.countReferences(idB)],
      [idC, index.countReferences(idC)]
    ])
    expect(batch.get(idA)).toBe(2)
    expect(batch.get(idB)).toBe(1)
    expect(batch.get(idC)).toBe(0)
  })

  it('reports unknown for the whole batch when any owner cannot be read', () => {
    const index = new AgentTombstoneReferenceIndex()
    index.register({ owner: 'automation', scan: () => ({ ok: true, referencedIds: [idA] }) })
    index.register({ owner: 'session', scan: () => ({ ok: false }) })

    const batch = countForIds(index, [idA, idB])
    // Same conservative retain the per-id path produces.
    expect(index.countReferences(idB)).toBe('unknown')
    expect(batch.get(idA)).toBe('unknown')
    expect(batch.get(idB)).toBe('unknown')
  })

  it('answers an empty batch without claiming references', () => {
    const index = new AgentTombstoneReferenceIndex()
    index.register({ owner: 'automation', scan: () => ({ ok: true, referencedIds: [idA] }) })
    expect([...countForIds(index, [])]).toEqual([])
  })
})
