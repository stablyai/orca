import { describe, expect, it } from 'vitest'
import { getOptionalStringFlagRejectingEmpty } from './flags'

// Why: an omitted --agent falls back to the Settings default, so an empty one must fail
// instead of silently launching the fallback.
describe('getOptionalStringFlagRejectingEmpty', () => {
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
