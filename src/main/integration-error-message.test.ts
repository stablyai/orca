import { describe, expect, it } from 'vitest'
import {
  boundedIntegrationErrorLog,
  boundedIntegrationErrorMessage,
  MAX_INTEGRATION_ERROR_MESSAGE_CHARS
} from './integration-error-message'

describe('boundedIntegrationErrorMessage', () => {
  it('preserves the exact character boundary and truncates character +1', () => {
    const exact = 'a'.repeat(MAX_INTEGRATION_ERROR_MESSAGE_CHARS)
    expect(boundedIntegrationErrorMessage(new Error(exact))).toBe(exact)

    const truncated = boundedIntegrationErrorMessage(`${exact}b`)
    expect(truncated).toHaveLength(MAX_INTEGRATION_ERROR_MESSAGE_CHARS)
    expect(truncated.endsWith('…')).toBe(true)
  })

  it('bounds retained stack text used by provider logs', () => {
    const error = new Error('failed')
    error.stack = 's'.repeat(MAX_INTEGRATION_ERROR_MESSAGE_CHARS + 1)

    expect(boundedIntegrationErrorLog(error)).toHaveLength(MAX_INTEGRATION_ERROR_MESSAGE_CHARS)
  })
})
