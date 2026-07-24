import { describe, expect, it } from 'vitest'
import { MobileRpcListCache } from './mobile-rpc-list-cache'

describe('MobileRpcListCache', () => {
  it('preserves values below the limits and expires them at the existing age boundary', () => {
    const cache = new MobileRpcListCache(100, 2, 3, 100)
    const values = [{ id: 'repo' }]

    expect(cache.set('host', values, 1_000)).toBe(true)
    expect(cache.get('host', 1_100)).toBe(values)
    expect(cache.get('host', 1_101)).toBeNull()
  })

  it('accepts the exact item cap and rejects one over', () => {
    const cache = new MobileRpcListCache(100, 2, 3, 1_000)
    const exact = [1, 2, 3]

    expect(cache.set('host', exact)).toBe(true)
    expect(cache.get('host')).toBe(exact)
    expect(cache.set('host', [...exact, 4])).toBe(false)
    expect(cache.get('host')).toBeNull()
  })

  it('accepts the exact aggregate byte budget and evicts oldest at one over', () => {
    const probe = new MobileRpcListCache(100, 3, 3, 1_000)
    probe.set('first', ['a'])
    const firstBytes = probe.evidence().retainedBytes
    probe.clear()

    const cache = new MobileRpcListCache(100, 3, 3, firstBytes * 2)
    expect(cache.set('first', ['a'])).toBe(true)
    expect(cache.set('other', ['a'])).toBe(true)
    expect(cache.evidence().retainedBytes).toBe(firstBytes * 2)

    expect(cache.set('x', [])).toBe(true)
    expect(cache.get('first')).toBeNull()
    expect(cache.evidence().retainedBytes).toBeLessThanOrEqual(firstBytes * 2)
  })

  it('rejects a single payload larger than the full byte budget', () => {
    const cache = new MobileRpcListCache(100, 2, 3, 20)

    expect(cache.set('host', ['a'.repeat(100)])).toBe(false)
    expect(cache.evidence()).toEqual({
      entryCount: 0,
      retainedBytes: 0,
      keysOldestFirst: []
    })
  })
})
