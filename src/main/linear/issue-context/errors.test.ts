import { describe, expect, it } from 'vitest'
import { sanitizeLinearErrorMessage } from './errors'

describe('sanitizeLinearErrorMessage', () => {
  it('removes CRLF stack frames from error messages', () => {
    expect(
      sanitizeLinearErrorMessage('Linear request failed\r\n    at request (sdk.js:10:2)')
    ).toBe('Linear request failed')
  })

  it('redacts sensitive Linear payloads after trimming stack frames', () => {
    expect(
      sanitizeLinearErrorMessage(
        'Request failed authorization: Bearer secret-token\n    at request (sdk.js:10:2)'
      )
    ).toBe('Request failed authorization: Bearer [REDACTED]')
  })
})
