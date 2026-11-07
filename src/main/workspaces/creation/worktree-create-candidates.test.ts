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
  const unprefixed = (names: readonly string[]) => ({
    baseName: 'feature',
    branchBaseName: 'feature',
    existingBranchNames: names,
    existingCandidateNames: names
  })

  it('starts beyond the highest existing numeric suffix only when the base name is taken', () => {
    const existing = ['feature', ...Array.from({ length: 100 }, (_, i) => `feature-${i + 1}`)]
    expect(getWorktreeCreateStartingSuffix(unprefixed(existing))).toBe(101)
    expect(getWorktreeCreateStartingSuffix(unprefixed([]))).toBe(1)
    expect(getWorktreeCreateStartingSuffix(unprefixed(['feature-50']))).toBe(1)
    expect(
      getWorktreeCreateStartingSuffix(unprefixed(['feature', 'feature-foo', 'feature-2-3']))
    ).toBe(1)
  })

  it('finds the base under the rewritten .lock branch name', () => {
    const names = ['foo-lock', 'foo.lock-2', 'foo.lock-3']
    expect(
      getWorktreeCreateStartingSuffix({
        baseName: 'foo.lock',
        branchBaseName: 'foo-lock',
        existingBranchNames: names,
        existingCandidateNames: names
      })
    ).toBe(4)
    expect(
      getWorktreeCreateStartingSuffix({
        baseName: 'foo.lock',
        branchBaseName: 'foo-lock',
        existingBranchNames: ['foo.lock-2'],
        existingCandidateNames: ['foo.lock-2']
      })
    ).toBe(1)
  })

  it('gates on the prefixed branch, not on an unrelated unprefixed sibling', () => {
    expect(
      getWorktreeCreateStartingSuffix({
        baseName: 'feature',
        branchBaseName: 'alice/feature',
        existingBranchNames: ['feature', 'feature-100'],
        existingCandidateNames: ['feature', 'feature-100']
      })
    ).toBe(1)
    expect(
      getWorktreeCreateStartingSuffix({
        baseName: 'feature',
        branchBaseName: 'alice/feature',
        existingBranchNames: ['alice/feature', 'alice/feature-100'],
        existingCandidateNames: ['feature', 'feature-100']
      })
    ).toBe(101)
  })
})
