import { describe, expect, it } from 'vitest'
import { mobileLogErrorKind } from './mobile-log-error-kind'

describe('mobileLogErrorKind', () => {
  it('does not expose custom error names or messages', () => {
    const error = new Error('credential-secret /private/repository')
    error.name = 'credential-secret'

    expect(mobileLogErrorKind(error)).toBe('error')
    expect(mobileLogErrorKind('credential-secret')).toBe('string')
  })
})
