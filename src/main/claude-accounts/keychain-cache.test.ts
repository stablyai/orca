import { describe, expect, it } from 'vitest'
import { createKeychainCache } from './keychain-cache'

describe('keychain-cache', () => {
  it('returns undefined on miss', () => {
    const c = createKeychainCache(2)
    expect(c.get('a')).toBeUndefined()
  })

  it('returns value on hit', () => {
    const c = createKeychainCache(2)
    c.set('a', 'val-a')
    expect(c.get('a')).toBe('val-a')
  })

  it('evicts LRU entry when size limit exceeded', () => {
    const c = createKeychainCache(2)
    c.set('a', 'A')
    c.set('b', 'B')
    c.set('c', 'C')
    expect(c.get('a')).toBeUndefined() // evicted
    expect(c.get('b')).toBe('B')
    expect(c.get('c')).toBe('C')
  })

  it('get() marks entry as recently used (touches order)', () => {
    const c = createKeychainCache(2)
    c.set('a', 'A')
    c.set('b', 'B')
    c.get('a') // touch a → b is LRU
    c.set('c', 'C')
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBe('A')
  })

  it('invalidate(key) removes a specific entry', () => {
    const c = createKeychainCache(2)
    c.set('a', 'A')
    c.invalidate('a')
    expect(c.get('a')).toBeUndefined()
  })

  it('clear() empties the cache', () => {
    const c = createKeychainCache(2)
    c.set('a', 'A')
    c.set('b', 'B')
    c.clear()
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBeUndefined()
  })

  it('caches null sentinel (so we do not re-probe missing entries)', () => {
    const c = createKeychainCache(2)
    c.set('a', null)
    expect(c.has('a')).toBe(true)
    expect(c.get('a')).toBeNull()
  })
})
