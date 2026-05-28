import { describe, expect, it } from 'vitest'

import { getRequiredStringFlagAllowingEmpty } from './flags'

describe('CLI flags', () => {
  it('allows required string flags to be empty when the command opts in', () => {
    const flags = new Map<string, string | boolean>([['value', '']])

    expect(getRequiredStringFlagAllowingEmpty(flags, 'value')).toBe('')
  })
})
