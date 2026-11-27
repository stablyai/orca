import { describe, expect, it } from 'vitest'
import { googleDefaultAccountLine } from './google-default-account'

describe('orca google default', () => {
  it('names the accounts to pick from when the saved default cannot be read', () => {
    const line = googleDefaultAccountLine(null, ['a@acme.com', 'b@acme.com'])
    expect(line).not.toContain('No Google account is connected')
    expect(line).toContain('a@acme.com, b@acme.com')
    expect(googleDefaultAccountLine(null, [])).toBe(
      'No Google account is connected on this computer.'
    )
  })
})
