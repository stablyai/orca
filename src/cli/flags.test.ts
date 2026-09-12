import { describe, expect, it } from 'vitest'

import { getOptionalStringFlagRejectingEmpty, getRequiredStringFlagAllowingEmpty } from './flags'

describe('CLI flags', () => {
  it('allows required string flags to be empty when the command opts in', () => {
    const flags = new Map<string, string | boolean>([['value', '']])

    expect(getRequiredStringFlagAllowingEmpty(flags, 'value')).toBe('')
  })

  it('rejects an explicitly empty or valueless optional flag but passes an absent one', () => {
    expect(getOptionalStringFlagRejectingEmpty(new Map([['agent', 'codex']]), 'agent')).toBe(
      'codex'
    )
    expect(getOptionalStringFlagRejectingEmpty(new Map(), 'agent')).toBeUndefined()
    expect(() => getOptionalStringFlagRejectingEmpty(new Map([['agent', '']]), 'agent')).toThrow(
      /--agent requires a value/
    )
    expect(() =>
      getOptionalStringFlagRejectingEmpty(
        new Map<string, string | boolean>([['agent', true]]),
        'agent'
      )
    ).toThrow(/--agent requires a value/)
  })
})
