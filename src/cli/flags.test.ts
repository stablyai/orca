import { describe, expect, it } from 'vitest'

import { getOptionalPresentStringFlag, getRequiredStringFlagAllowingEmpty } from './flags'

describe('CLI flags', () => {
  it('allows required string flags to be empty when the command opts in', () => {
    const flags = new Map<string, string | boolean>([['value', '']])

    expect(getRequiredStringFlagAllowingEmpty(flags, 'value')).toBe('')
  })

  it('treats a missing optional present flag as omitted', () => {
    expect(getOptionalPresentStringFlag(new Map(), 'terminal')).toBeUndefined()
  })

  it('rejects an explicit empty optional present flag', () => {
    expect(() => getOptionalPresentStringFlag(new Map([['terminal', '']]), 'terminal')).toThrow(
      /non-empty/
    )
  })
})
