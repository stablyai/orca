import { describe, expect, it } from 'vitest'
import { databaseSameSite } from './browser-cookie-validation'

describe('databaseSameSite', () => {
  it.each([
    { raw: -1, expected: 'unspecified' },
    { raw: 0, expected: 'no_restriction' },
    { raw: 1, expected: 'lax' },
    { raw: 2, expected: 'strict' },
    { raw: 3, expected: 'unspecified' },
    // Why: 256 is Firefox's nsICookie SAMESITE_UNSET, written for every cookie with no SameSite
    // attribute -- the most common shape in a modern Firefox profile. It reaches the default arm,
    // so without this case the decoder's busiest Firefox input would be untested.
    { raw: 256, expected: 'unspecified' },
    { raw: 99, expected: 'unspecified' },
    { raw: 1.5, expected: 'unspecified' }
  ] as const)('decodes $raw as $expected', ({ raw, expected }) => {
    expect(databaseSameSite(raw)).toBe(expected)
  })

  // Why: pre-v10 Firefox rows carry NULL, and the Chromium scan feeds `?? -1`. Both arrive here as
  // a non-integer rather than a number, and both must be unspecified rather than None (0).
  it.each([
    { label: 'null', raw: null },
    { label: 'undefined', raw: undefined },
    { label: 'NaN', raw: Number.NaN }
  ])('decodes $label as unspecified', ({ raw }) => {
    expect(databaseSameSite(raw as unknown as number)).toBe('unspecified')
  })
})
