import { describe, expect, it } from 'vitest'
import { clampLimit, normalizeIdArray, normalizeRecordId } from './odoo-ipc-args'

describe('clampLimit', () => {
  it('clamps into the 1..100 window', () => {
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(500)).toBe(100)
    expect(clampLimit(42)).toBe(42)
  })

  it('truncates a fractional limit, which Odoo rejects', () => {
    expect(clampLimit(30.7)).toBe(30)
    expect(clampLimit(-2.5)).toBe(1)
  })

  it('falls back for non-numeric input and for an unusable fallback', () => {
    expect(clampLimit('30')).toBe(30)
    expect(clampLimit(undefined)).toBe(30)
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(30)
    expect(clampLimit(undefined, Number.NaN)).toBe(30)
    expect(clampLimit(undefined, 12.9)).toBe(12)
  })
})

describe('normalizeRecordId', () => {
  it('accepts positive integers only', () => {
    expect(normalizeRecordId(7)).toBe(7)
    expect(normalizeRecordId(0)).toBeNull()
    expect(normalizeRecordId(-3)).toBeNull()
    expect(normalizeRecordId(1.5)).toBeNull()
    expect(normalizeRecordId('7')).toBeNull()
  })

  it('rejects ids past the safe-integer range, which JSON-RPC would re-round', () => {
    expect(normalizeRecordId(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    expect(normalizeRecordId(Number.MAX_SAFE_INTEGER + 2)).toBeNull()
    expect(normalizeRecordId(2 ** 60)).toBeNull()
  })
})

describe('normalizeIdArray', () => {
  it('normalizes a dense array and rejects any invalid member', () => {
    expect(normalizeIdArray([1, 2, 3])).toEqual([1, 2, 3])
    expect(normalizeIdArray([1, 'x'])).toBeUndefined()
    expect(normalizeIdArray([])).toEqual([])
    expect(normalizeIdArray('nope')).toBeUndefined()
    expect(normalizeIdArray(undefined)).toBeUndefined()
  })

  it('rejects a sparse array instead of returning holes', () => {
    // `map`/`every` skip holes, so a hole-only array used to pass validation.
    const holeOnly: number[] = []
    holeOnly.length = 1
    expect(normalizeIdArray(holeOnly)).toBeUndefined()
    const sparse = [1, 2]
    delete sparse[0]
    expect(normalizeIdArray(sparse)).toBeUndefined()
  })
})
