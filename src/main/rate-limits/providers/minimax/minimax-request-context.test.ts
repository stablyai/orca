import { describe, expect, it } from 'vitest'
import { redactMiniMaxSecret } from './minimax-request-context'

describe('redactMiniMaxSecret', () => {
  it('redacts _token values in header and quoted syntax', () => {
    const redacted = redactMiniMaxSecret('cookie _token=eyJhABCDEF and _token:"x.y"')
    expect(redacted).toContain('_token=[REDACTED]')
    expect(redacted).not.toContain('eyJhABCDEF')
    expect(redacted).not.toContain('x.y')
  })

  it('redacts quoted values with whitespace around the colon', () => {
    const redacted = redactMiniMaxSecret('_token : "spaced.secret"')
    expect(redacted).not.toContain('spaced.secret')
    expect(redacted).toContain('_token:[REDACTED]')
  })
})
