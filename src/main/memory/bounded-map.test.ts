import { describe, expect, it } from 'vitest'
import { BoundedMap } from './bounded-map'

describe('BoundedMap', () => {
  it('rejects non-positive maxEntries', () => {
    expect(() => new BoundedMap({ maxEntries: 0 })).toThrow()
    expect(() => new BoundedMap({ maxEntries: -5 })).toThrow()
    expect(() => new BoundedMap({ maxEntries: 1.5 })).toThrow()
  })

  it('behaves like a Map up to the cap', () => {
    const map = new BoundedMap<string, number>({ maxEntries: 3 })
    map.set('a', 1)
    map.set('b', 2)
    expect(map.get('a')).toBe(1)
    expect(map.has('b')).toBe(true)
    expect(map.size).toBe(2)
    expect([...map.keys()]).toEqual(['a', 'b'])
    expect([...map.values()]).toEqual([1, 2])
    expect(map.delete('a')).toBe(true)
    expect(map.has('a')).toBe(false)
  })

  it('evicts in insertion order when no rank is provided', () => {
    const map = new BoundedMap<string, number>({ maxEntries: 2 })
    map.set('a', 1)
    map.set('b', 2)
    map.set('c', 3)
    expect(map.size).toBe(2)
    expect(map.has('a')).toBe(false)
    expect(map.has('b')).toBe(true)
    expect(map.has('c')).toBe(true)
  })

  it('evicts by LRU rank when one is provided', () => {
    type V = { lastAccessedAt: number; payload: string }
    const map = new BoundedMap<string, V>({
      maxEntries: 2,
      evictionRank: (a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt
    })
    let now = 0
    map.set('a', { lastAccessedAt: now++, payload: 'A' })
    map.set('b', { lastAccessedAt: now++, payload: 'B' })
    // Refresh 'a' so 'b' becomes oldest.
    map.set('a', { lastAccessedAt: now++, payload: 'A2' })
    map.set('c', { lastAccessedAt: now++, payload: 'C' })
    expect(map.size).toBe(2)
    expect(map.has('b')).toBe(false)
    expect(map.has('a')).toBe(true)
    expect(map.has('c')).toBe(true)
  })

  it('replaces value when re-setting an existing key without evicting', () => {
    const map = new BoundedMap<string, number>({ maxEntries: 2 })
    map.set('a', 1)
    map.set('b', 2)
    map.set('a', 99)
    expect(map.get('a')).toBe(99)
    expect(map.size).toBe(2)
  })

  it('exposes Map iterator protocol', () => {
    const map = new BoundedMap<string, number>({ maxEntries: 3 })
    map.set('a', 1)
    map.set('b', 2)
    const collected: [string, number][] = []
    for (const entry of map) {
      collected.push(entry)
    }
    expect(collected).toEqual([
      ['a', 1],
      ['b', 2]
    ])
    const forEachCollected: [unknown, unknown][] = []
    map.forEach((v, k) => forEachCollected.push([k, v]))
    expect(forEachCollected).toEqual([
      ['a', 1],
      ['b', 2]
    ])
  })
})
