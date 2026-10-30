import { describe, expect, it } from 'vitest'
import { prStateToken } from './pr-state-token'

describe('prStateToken', () => {
  it('is case-insensitive and falls back to muted for unknown states', () => {
    expect(prStateToken('MERGED')).toBe('statusPurple')
    expect(prStateToken('unknown')).toBe('textSecondary')
    expect(prStateToken('')).toBe('textSecondary')
  })
})
