import { describe, expect, it } from 'vitest'
import { databaseSameSite } from './browser-cookie-validation'

describe('databaseSameSite', () => {
  it.each([
    { raw: -1, expected: 'unspecified' },
    { raw: 0, expected: 'no_restriction' },
    { raw: 1, expected: 'lax' },
    { raw: 2, expected: 'strict' },
    { raw: 3, expected: 'unspecified' },
    { raw: 99, expected: 'unspecified' },
    { raw: 1.5, expected: 'unspecified' }
  ] as const)('decodes $raw as $expected', ({ raw, expected }) => {
    expect(databaseSameSite(raw)).toBe(expected)
  })
})
