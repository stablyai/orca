import { describe, expect, it } from 'vitest'
import { isRelayDatabaseTransientError } from './database.js'

describe('relay database transient errors', () => {
  it.each(['40P01', '40001', '55P03', '57014', '53300', '57P03', '08001', '08006'])(
    'classifies PostgreSQL code %s as retryable overload',
    (code) => {
      expect(isRelayDatabaseTransientError({ code })).toBe(true)
    }
  )

  it('classifies pool acquisition timeout without hiding programming failures', () => {
    expect(
      isRelayDatabaseTransientError(new Error('timeout exceeded when trying to connect'))
    ).toBe(true)
    expect(isRelayDatabaseTransientError(new TypeError('broken invariant'))).toBe(false)
  })
})
