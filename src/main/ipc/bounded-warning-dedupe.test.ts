import { describe, expect, it } from 'vitest'
import { shouldEmitBoundedWarning } from './bounded-warning-dedupe'

describe('shouldEmitBoundedWarning', () => {
  it('keeps retained warning keys quiet without cascade eviction after saturation', () => {
    const warningKeys = new Set<string>()

    expect(shouldEmitBoundedWarning(warningKeys, 'retained-1', 3)).toBe(true)
    expect(shouldEmitBoundedWarning(warningKeys, 'retained-2', 3)).toBe(true)
    expect(shouldEmitBoundedWarning(warningKeys, 'retained-3', 3)).toBe(true)

    expect(shouldEmitBoundedWarning(warningKeys, 'overflow', 3)).toBe(true)
    expect(shouldEmitBoundedWarning(warningKeys, 'retained-1', 3)).toBe(false)
    expect(shouldEmitBoundedWarning(warningKeys, 'retained-2', 3)).toBe(false)
    expect(shouldEmitBoundedWarning(warningKeys, 'retained-3', 3)).toBe(false)
    expect(shouldEmitBoundedWarning(warningKeys, 'overflow', 3)).toBe(true)

    expect([...warningKeys]).toEqual(['retained-1', 'retained-2', 'retained-3'])
  })
})
