import { describe, expect, it } from 'vitest'
import { isFullGitObjectId } from './commit-object-ref'

describe('isFullGitObjectId', () => {
  it('accepts full SHA-1 and SHA-256 object IDs only', () => {
    expect(isFullGitObjectId('a'.repeat(40))).toBe(true)
    expect(isFullGitObjectId('A'.repeat(64))).toBe(true)
    expect(isFullGitObjectId('a'.repeat(63))).toBe(false)
    expect(isFullGitObjectId('a'.repeat(65))).toBe(false)
  })
})
