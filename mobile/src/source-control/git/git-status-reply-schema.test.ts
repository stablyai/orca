import { describe, expect, it } from 'vitest'
import { gitStatusHostPayloadSchema } from './git-status-reply-schema'

describe('gitStatusHostPayloadSchema', () => {
  // The phone advertises the revert capability, so hosts send revert instead of unknown.
  it('keeps a paused revert', () => {
    expect(
      gitStatusHostPayloadSchema.parse({ entries: [], conflictOperation: 'revert' })
        .conflictOperation
    ).toBe('revert')
  })
})
