import { describe, expect, it } from 'vitest'
import {
  getGeneratedWorktreeCreateCandidate,
  getWorktreeCreateStartingSuffix
} from './worktree-create-candidates'
import { isGeneratedWorktreeCreateName } from '../../../shared/new-workspace/worktree-create-retry-policy'

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

describe('worktree create starting suffix', () => {
  it('starts beyond the highest existing numeric suffix only when the base name is taken', () => {
    const existing = ['feature', ...Array.from({ length: 100 }, (_, i) => `feature-${i + 1}`)]
    expect(getWorktreeCreateStartingSuffix('feature', existing)).toBe(101)
    expect(getWorktreeCreateStartingSuffix('feature', [])).toBe(1)
    expect(getWorktreeCreateStartingSuffix('feature', ['feature-50'])).toBe(1)
    expect(
      getWorktreeCreateStartingSuffix('feature', ['feature', 'feature-foo', 'feature-2-3'])
    ).toBe(1)
  })
})
