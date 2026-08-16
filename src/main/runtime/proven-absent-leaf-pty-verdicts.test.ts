import { describe, expect, it } from 'vitest'
import {
  PROVEN_ABSENT_LEAF_PTY_MAX_ENTRIES,
  PROVEN_ABSENT_LEAF_PTY_TTL_MS,
  pruneProvenAbsentLeafPtyVerdicts,
  recordProvenAbsentLeafPtyVerdict
} from './proven-absent-leaf-pty-verdicts'

describe('pruneProvenAbsentLeafPtyVerdicts', () => {
  it('drops expired entries without re-access', () => {
    const map = new Map<string, number>([
      ['live', 1_000],
      ['stale', 1_000]
    ])
    pruneProvenAbsentLeafPtyVerdicts(map, 1_000 + PROVEN_ABSENT_LEAF_PTY_TTL_MS + 1)
    expect(map.size).toBe(0)
  })

  it('keeps fresh entries', () => {
    const map = new Map<string, number>([['fresh', 5_000]])
    pruneProvenAbsentLeafPtyVerdicts(map, 5_000 + 1_000)
    expect(map.get('fresh')).toBe(5_000)
  })

  it('evicts oldest when over the max after TTL prune', () => {
    const map = new Map<string, number>()
    const now = 100_000
    for (let i = 0; i < PROVEN_ABSENT_LEAF_PTY_MAX_ENTRIES + 10; i += 1) {
      map.set(`pty-${i}`, now - i)
    }
    pruneProvenAbsentLeafPtyVerdicts(map, now, PROVEN_ABSENT_LEAF_PTY_TTL_MS, 16)
    expect(map.size).toBe(16)
    // Newest timestamps survive (lowest i in this construction).
    expect(map.has('pty-0')).toBe(true)
    expect(map.has('pty-25')).toBe(false)
  })

  it('enforces the capacity immediately after every verdict write', () => {
    const map = new Map<string, number>()
    const maxEntries = 16
    for (let index = 0; index < maxEntries + 10; index += 1) {
      recordProvenAbsentLeafPtyVerdict(
        map,
        `pty-${index}`,
        100_000 + index,
        PROVEN_ABSENT_LEAF_PTY_TTL_MS,
        maxEntries
      )
      expect(map.size).toBeLessThanOrEqual(maxEntries)
    }
    expect(map.has('pty-0')).toBe(false)
    expect(map.has('pty-25')).toBe(true)
  })
})
