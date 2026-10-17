import { describe, expect, it } from 'vitest'
import { areStructurallyEqual } from './structural-equality'

describe('areStructurallyEqual', () => {
  it('equates value-equal nested objects and arrays', () => {
    const value = () => ({ id: 'a', agents: [{ state: 'working', mainAgent: { stopping: true } }] })
    expect(areStructurallyEqual(value(), value())).toBe(true)
    expect(areStructurallyEqual([1, [2, { x: null }]], [1, [2, { x: null }]])).toBe(true)
  })

  it('detects a changed nested value', () => {
    expect(
      areStructurallyEqual({ agents: [{ state: 'working' }] }, { agents: [{ state: 'done' }] })
    ).toBe(false)
    expect(areStructurallyEqual([1, 2], [1, 2, 3])).toBe(false)
  })

  it('counts keys, so an added or removed key is a change even when undefined', () => {
    expect(areStructurallyEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(areStructurallyEqual({ a: 1, b: undefined }, { a: 1 })).toBe(false)
    expect(areStructurallyEqual({ a: 1 }, { b: 1 })).toBe(false)
  })

  it('compares functions by identity', () => {
    const press = () => {}
    expect(areStructurallyEqual({ press }, { press })).toBe(true)
    expect(areStructurallyEqual({ press }, { press: () => {} })).toBe(false)
  })

  it('does not equate an array with an object of the same entries', () => {
    expect(areStructurallyEqual(['a'], { 0: 'a' })).toBe(false)
    expect(areStructurallyEqual([], {})).toBe(false)
  })

  it('compares primitives with Object.is', () => {
    expect(areStructurallyEqual(Number.NaN, Number.NaN)).toBe(true)
    expect(areStructurallyEqual(null, undefined)).toBe(false)
    expect(areStructurallyEqual(0, '0')).toBe(false)
    expect(areStructurallyEqual(0, -0)).toBe(false)
  })

  it('compares own enumerable string keys regardless of insertion order', () => {
    expect(areStructurallyEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true)
    const right = Object.create({ a: 1 })
    right.b = 2
    expect(areStructurallyEqual({ a: 1 }, right)).toBe(false)
    Object.defineProperty(right, 'a', { value: 1, enumerable: false })
    expect(areStructurallyEqual({ a: 1 }, right)).toBe(false)
    expect(areStructurallyEqual({ b: 2 }, right)).toBe(true)
  })

  it('keeps enumerable-key semantics for sparse arrays and extra array properties', () => {
    const short = Array.from({ length: 2 }, () => 1)
    const long = Array.from({ length: 3 }, () => 1)
    delete short[1]
    delete long[1]
    delete long[2]
    expect(areStructurallyEqual(short, long)).toBe(true)
    Object.defineProperty(long, 'label', { value: 'long', enumerable: true })
    expect(areStructurallyEqual(short, long)).toBe(false)
  })

  it('ignores symbols and non-enumerable fields, and compares null-prototype records', () => {
    const left = Object.assign(Object.create(null), { a: 1, [Symbol('left')]: 2 })
    Object.defineProperty(left, 'hidden', { value: 3 })
    expect(areStructurallyEqual(left, { a: 1 })).toBe(true)
    expect(areStructurallyEqual(left, { a: 2 })).toBe(false)
  })

  it('observes a mutation on the next comparison without caching an old verdict', () => {
    const left = { a: [{ state: 'working' }] }
    const right = { a: [{ state: 'working' }] }
    expect(areStructurallyEqual(left, right)).toBe(true)
    right.a[0]!.state = 'done'
    expect(areStructurallyEqual(left, right)).toBe(false)
  })

  it('reads both operands eagerly, left before right, including values after a difference', () => {
    const reads: string[] = []
    const left = {
      get a() {
        reads.push('left.a')
        return 1
      },
      get b() {
        reads.push('left.b')
        return 2
      }
    }
    const right = {
      get a() {
        reads.push('right.a')
        return 3
      },
      get b() {
        reads.push('right.b')
        return 2
      }
    }
    expect(areStructurallyEqual(left, right)).toBe(false)
    expect(reads).toEqual(['left.a', 'left.b', 'right.a', 'right.b'])
  })

  it('captures right values before nested comparison can mutate them', () => {
    const right = { nested: { a: 1 }, later: 1 }
    const left = {
      nested: {
        get a() {
          right.later = 2
          return 1
        }
      },
      later: 1
    }
    expect(areStructurallyEqual(left, right)).toBe(true)
    expect(right.later).toBe(2)
  })

  it('keeps getters throwing even after a difference or a key-count mismatch', () => {
    const failure = new Error('unreadable field')
    const right = {
      a: 2,
      get b() {
        throw failure
      }
    }
    expect(() => areStructurallyEqual({ a: 1, b: 1 }, right)).toThrow(failure)
    expect(() => areStructurallyEqual({}, right)).toThrow(failure)
  })

  it('keeps Proxy enumeration and getter order', () => {
    const observed: string[] = []
    const right = new Proxy(
      { a: 1, b: 2 },
      {
        ownKeys: (target) => {
          observed.push('keys')
          return Object.keys(target)
        },
        getOwnPropertyDescriptor: (target, key) => {
          observed.push(`descriptor:${String(key)}`)
          return Object.getOwnPropertyDescriptor(target, key)
        },
        get: (target, key) => {
          observed.push(`get:${String(key)}`)
          return key === 'a' ? target.a : target.b
        }
      }
    )
    expect(areStructurallyEqual({ a: 1, b: 2 }, right)).toBe(true)
    expect(observed).toEqual(['keys', 'descriptor:a', 'get:a', 'descriptor:b', 'get:b'])
  })

  it('avoids allocating lookup indexes when catalog key order matches', () => {
    const left = Array.from({ length: 3000 }, (_, index) => ({
      id: `row-${index}`,
      nested: { a: 1 }
    }))
    const right = structuredClone(left)
    const NativeMap = globalThis.Map
    let allocations = 0
    class CountedMap<K, V> extends NativeMap<K, V> {
      constructor(entries?: Iterable<readonly [K, V]> | null) {
        super(entries)
        allocations += 1
      }
    }
    globalThis.Map = CountedMap
    let equal: boolean
    try {
      equal = areStructurallyEqual(left, right)
    } finally {
      globalThis.Map = NativeMap
    }
    expect(equal).toBe(true)
    expect(allocations).toBe(0)
  })
})
