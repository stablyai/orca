import { describe, expect, it } from 'vitest'
import {
  getGeneratedWorktreeCreateCandidate,
  isGeneratedWorktreeCreateName
} from './worktree-create-candidates'

describe('generated worktree create candidates', () => {
  it('advances canonical tiers instead of nesting collision suffixes', () => {
    expect(getGeneratedWorktreeCreateCandidate('nautilus-2', 1)).toBe('nautilus-2')
    expect(getGeneratedWorktreeCreateCandidate('nautilus-2', 2)).toBe('nautilus-3')
    expect(getGeneratedWorktreeCreateCandidate('nautilus-2', 99)).toBe('nautilus-100')
    expect(getGeneratedWorktreeCreateCandidate('nautilus', 1, 100)).toBe('nautilus-101')
  })

  it('canonicalizes legacy nested generated suffixes', () => {
    expect(isGeneratedWorktreeCreateName('nautilus')).toBe(true)
    expect(isGeneratedWorktreeCreateName('nautilus-2')).toBe(true)
    expect(isGeneratedWorktreeCreateName('nautilus-2-3')).toBe(true)
    expect(getGeneratedWorktreeCreateCandidate('nautilus-2-3', 1)).toBe('nautilus-4')
    expect(isGeneratedWorktreeCreateName('fix-login')).toBe(false)
  })
})
