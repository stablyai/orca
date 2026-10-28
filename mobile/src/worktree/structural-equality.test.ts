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
  })

  it('compares Sets by content, not as empty objects', () => {
    expect(areStructurallyEqual(new Set(['a']), new Set(['b']))).toBe(false)
    expect(areStructurallyEqual(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
    expect(areStructurallyEqual({ retrying: new Set(['m1']) }, { retrying: new Set() })).toBe(false)
    expect(areStructurallyEqual(new Set(), {})).toBe(false)
  })

  it('compares Maps by content', () => {
    expect(areStructurallyEqual(new Map([['a', { n: 1 }]]), new Map([['a', { n: 1 }]]))).toBe(true)
    expect(areStructurallyEqual(new Map([['a', { n: 1 }]]), new Map([['a', { n: 2 }]]))).toBe(false)
    expect(areStructurallyEqual(new Map([['a', 1]]), new Map([['b', 1]]))).toBe(false)
  })
})
