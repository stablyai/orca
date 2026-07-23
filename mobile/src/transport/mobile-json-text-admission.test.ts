import { describe, expect, it } from 'vitest'
import {
  isMobileJsonStructureCapacityError,
  parseMobileJsonTextWithinLimits
} from './mobile-json-text-admission'

describe('mobile JSON text admission', () => {
  it('accepts the exact structural-token limit and rejects one more', () => {
    const limits = { structuralTokens: 4, nestingDepth: 2 }

    expect(parseMobileJsonTextWithinLimits('[0,0,0]', limits)).toEqual([0, 0, 0])
    expect(() => parseMobileJsonTextWithinLimits('[0,0,0,0]', limits)).toThrow(
      'JSON structure exceeds 4 tokens'
    )
  })

  it('accepts the exact nesting limit and rejects one more', () => {
    const limits = { structuralTokens: 20, nestingDepth: 3 }

    expect(parseMobileJsonTextWithinLimits('[[[]]]', limits)).toEqual([[[]]])
    expect(() => parseMobileJsonTextWithinLimits('[[[[]]]]', limits)).toThrow(
      'JSON nesting exceeds 3 levels'
    )
  })

  it('does not count structural characters inside strings', () => {
    expect(
      parseMobileJsonTextWithinLimits('{"value":"[{\\\":,}]"}', {
        structuralTokens: 3,
        nestingDepth: 1
      })
    ).toEqual({ value: '[{":,}]' })
  })

  it('identifies capacity failures separately from malformed JSON', () => {
    const capacityError = captureError(() =>
      parseMobileJsonTextWithinLimits('[0,0]', {
        structuralTokens: 2,
        nestingDepth: 2
      })
    )
    const syntaxError = captureError(() =>
      parseMobileJsonTextWithinLimits('[', {
        structuralTokens: 2,
        nestingDepth: 2
      })
    )

    expect(isMobileJsonStructureCapacityError(capacityError)).toBe(true)
    expect(isMobileJsonStructureCapacityError(syntaxError)).toBe(false)
  })
})

function captureError(run: () => void): unknown {
  try {
    run()
    return null
  } catch (error) {
    return error
  }
}
