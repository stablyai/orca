import { describe, expect, it } from 'vitest'
import { redactString } from './redactor'

describe('environment line redaction parity', () => {
  it('keeps rule ordering for labeled secrets within environment values', () => {
    expect(redactString('\n\r\nFOO=token: value\nBAR=other')).toBe(
      'FOO=[redacted:env-value]\nBAR=[redacted:env-value]'
    )
  })
})
