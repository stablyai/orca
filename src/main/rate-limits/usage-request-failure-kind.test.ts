import { describe, expect, it } from 'vitest'
import { classifyThrownUsageRequestError } from './usage-request-failure-kind'

describe('classifyThrownUsageRequestError', () => {
  it('classifies transport errors and timeouts as network failures', () => {
    expect(classifyThrownUsageRequestError(new TypeError('fetch failed'))).toBe('network')
    expect(
      classifyThrownUsageRequestError(new DOMException('The operation timed out.', 'TimeoutError'))
    ).toBe('network')
  })

  it('classifies a malformed body as a parse failure', () => {
    expect(classifyThrownUsageRequestError(new SyntaxError('Unexpected token'))).toBe('parse')
  })
})
