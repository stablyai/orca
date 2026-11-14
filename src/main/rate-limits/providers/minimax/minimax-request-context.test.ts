import { describe, expect, it } from 'vitest'
import { redactMiniMaxSecret } from './minimax-request-context'

describe('redactMiniMaxSecret', () => {
  it('redacts quoted values with whitespace around the colon', () => {
    const redacted = redactMiniMaxSecret('_token : "spaced.secret"')
    expect(redacted).not.toContain('spaced.secret')
    expect(redacted).toContain('_token:[REDACTED]')
  })
})
