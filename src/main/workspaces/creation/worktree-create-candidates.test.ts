import { describe, expect, it } from 'vitest'
import { getGeneratedWorktreeCreateCandidate } from './worktree-create-candidates'
import { isGeneratedWorktreeCreateName } from '../../../shared/new-workspace/worktree-create-retry-policy'

describe('generated worktree create candidates', () => {
  it('canonicalizes legacy nested generated suffixes', () => {
    expect(isGeneratedWorktreeCreateName('nautilus')).toBe(true)
    expect(isGeneratedWorktreeCreateName('nautilus-2')).toBe(true)
    expect(isGeneratedWorktreeCreateName('nautilus-2-3')).toBe(true)
    expect(getGeneratedWorktreeCreateCandidate('nautilus-2-3', 1)).toBe('nautilus-4')
    expect(isGeneratedWorktreeCreateName('fix-login')).toBe(false)
  })
})
