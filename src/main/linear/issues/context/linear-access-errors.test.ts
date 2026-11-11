import { describe, expect, it } from 'vitest'
import { sanitizeLinearErrorMessage } from './linear-access-errors'

describe('sanitizeLinearErrorMessage', () => {
  it('redacts sensitive Linear payloads after trimming stack frames', () => {
    expect(
      sanitizeLinearErrorMessage(
        'Request failed authorization: Bearer secret-token\n    at request (sdk.js:10:2)'
      )
    ).toBe('Request failed authorization: Bearer [REDACTED]')
  })
})
