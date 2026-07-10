import { describe, expect, it } from 'vitest'
import { resolveLinkedPrNumber } from './mobile-pr-sidebar-resolve'

describe('resolveLinkedPrNumber', () => {
  it('prefers the branch hint (open PR) when present', () => {
    expect(resolveLinkedPrNumber(7, 42)).toBe(7)
    expect(resolveLinkedPrNumber(7, null)).toBe(7)
  })

  it('falls back to the worktree linkedPR when there is no branch hint (closed/merged)', () => {
    expect(resolveLinkedPrNumber(null, 42)).toBe(42)
    expect(resolveLinkedPrNumber(undefined, 42)).toBe(42)
  })

  it('returns null when neither is available', () => {
    expect(resolveLinkedPrNumber(null, null)).toBeNull()
    expect(resolveLinkedPrNumber(undefined, undefined)).toBeNull()
  })
})
