import { describe, expect, it } from 'vitest'
import { isMobileMethodUnavailableError } from './mobile-method-unavailable'

describe('isMobileMethodUnavailableError', () => {
  it('detects old-desktop allowlist and missing-method failures', () => {
    expect(isMobileMethodUnavailableError('forbidden', undefined)).toBe(true)
    expect(isMobileMethodUnavailableError('method_not_found', undefined)).toBe(true)
    expect(
      isMobileMethodUnavailableError(
        'some_code',
        "Method 'files.readDir' is not available to mobile clients"
      )
    ).toBe(true)
    expect(isMobileMethodUnavailableError('internal', 'boom')).toBe(false)
    expect(isMobileMethodUnavailableError(undefined, undefined)).toBe(false)
  })
})
