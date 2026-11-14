import { describe, expect, it } from 'vitest'
import { areStructurallyEqual } from './structural-equality'

describe('areStructurallyEqual', () => {
  it('equates value-equal nested objects and arrays', () => {
    const value = () => ({ id: 'a', agents: [{ state: 'working', mainAgent: { stopping: true } }] })
    expect(areStructurallyEqual(value(), value())).toBe(true)
  })

  it('detects a changed nested value', () => {
    expect(
      areStructurallyEqual({ agents: [{ state: 'working' }] }, { agents: [{ state: 'done' }] })
    ).toBe(false)
    expect(areStructurallyEqual([1, 2], [1, 2, 3])).toBe(false)
  })
})
