import { describe, expect, it } from 'vitest'
import { computeBranchName, computeValidatedBranchName } from './worktree-branch-name'

describe('computeBranchName', () => {
  it('rewrites .lock suffix to -lock so git ref format rules pass', () => {
    expect(computeBranchName('fix-package.lock', { branchPrefix: 'none' }, null)).toBe(
      'fix-package-lock'
    )
    expect(computeBranchName('cargo.lock', { branchPrefix: 'none' }, null)).toBe('cargo-lock')
    expect(computeBranchName('feature/yarn.lock', { branchPrefix: 'none' }, null)).toBe(
      'feature/yarn-lock'
    )
  })

  it('prepends configured prefix while sanitizing branch leaf ending in .lock', () => {
    expect(computeBranchName('fix-package.lock', { branchPrefix: 'git-username' }, 'alice')).toBe(
      'alice/fix-package-lock'
    )
  })

  it('drops invalid derived git-username prefix', () => {
    expect(computeBranchName('fix-login', { branchPrefix: 'git-username' }, 'bad.lock')).toBe(
      'fix-login'
    )
  })
})

describe('computeValidatedBranchName', () => {
  it('rewrites .lock suffix to -lock', () => {
    expect(computeValidatedBranchName('my-worktree.lock', { branchPrefix: 'none' }, null)).toBe(
      'my-worktree-lock'
    )
  })

  it('rejects invalid custom prefix', () => {
    expect(() =>
      computeValidatedBranchName(
        'task',
        { branchPrefix: 'custom', branchPrefixCustom: 'bad:prefix' },
        null
      )
    ).toThrow('contains characters git rejects')
  })
})
