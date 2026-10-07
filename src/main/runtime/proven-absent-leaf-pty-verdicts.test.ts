import { describe, expect, it } from 'vitest'
import { pruneExpiredProvenAbsentLeafPtyVerdicts } from './proven-absent-leaf-pty-verdicts'

describe('pruneExpiredProvenAbsentLeafPtyVerdicts', () => {
  it('removes only entries at or past the TTL without a re-probe', () => {
    const map = new Map<string, number>([
      ['live-dead', 1_000],
      ['still-fresh', 1_400],
      ['exact-expiry', 1_000]
    ])
    pruneExpiredProvenAbsentLeafPtyVerdicts(map, 1_000 + 15_000, 15_000)
    expect([...map.keys()]).toEqual(['still-fresh'])
  })

  it('leaves an empty map alone', () => {
    const map = new Map<string, number>()
    pruneExpiredProvenAbsentLeafPtyVerdicts(map, Date.now(), 15_000)
    expect(map.size).toBe(0)
  })

  it('clears everything when ttl is non-positive', () => {
    const map = new Map<string, number>([['a', 1]])
    pruneExpiredProvenAbsentLeafPtyVerdicts(map, 100, 0)
    expect(map.size).toBe(0)
  })
})
