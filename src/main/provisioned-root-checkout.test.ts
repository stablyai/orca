import { describe, expect, it } from 'vitest'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { verifyProvisionedRootCheckout } from './provisioned-root-checkout'

const projectRoot = '/workspace/orca'

function gitWorktree(path: string, overrides: Partial<GitWorktreeInfo> = {}): GitWorktreeInfo {
  return {
    path,
    head: 'abc123',
    branch: 'refs/heads/fix-sandbox',
    isBare: false,
    isMainWorktree: true,
    ...overrides
  }
}

function verify(
  worktree: GitWorktreeInfo,
  request: Partial<Parameters<typeof verifyProvisionedRootCheckout>[0]['request']> = {},
  sparseCheckoutEnabled = false
): GitWorktreeInfo {
  return verifyProvisionedRootCheckout({
    worktrees: [worktree],
    sparseCheckoutEnabled,
    projectRoot,
    request: { name: 'fix-sandbox', ...request }
  })
}

describe('verifyProvisionedRootCheckout', () => {
  it('accepts the primary checkout on the requested branch', () => {
    expect(verify(gitWorktree(projectRoot)).path).toBe(projectRoot)
  })

  it('rejects a checkout on a branch Orca did not request', () => {
    expect(() => verify(gitWorktree(projectRoot, { branch: 'refs/heads/wrong' }))).toThrow(
      'requested branch'
    )
  })

  it('rejects a checkout that did not start from the requested ref', () => {
    expect(() =>
      verify(gitWorktree(projectRoot, { head: 'wrong-head' }), {
        baseBranch: 'v1.2.3',
        expectedRefHead: 'expected-head'
      })
    ).toThrow('requested ref')
  })

  it('accepts a requested branch created from a tag or commit ref', () => {
    expect(
      verify(gitWorktree(projectRoot), { baseBranch: 'v1.2.3', expectedRefHead: 'abc123' }).branch
    ).toBe('refs/heads/fix-sandbox')
  })

  it('rejects a requested ref without its source-host commit identity', () => {
    expect(() => verify(gitWorktree(projectRoot), { baseBranch: 'missing-ref' })).toThrow(
      'ref identity is missing'
    )
  })

  it('uses an explicit branch override as the requested local branch', () => {
    expect(
      verify(gitWorktree(projectRoot, { branch: 'refs/heads/feature/review' }), {
        branchNameOverride: 'feature/review'
      }).branch
    ).toBe('refs/heads/feature/review')
  })

  it('rejects a linked worktree and a sparse checkout', () => {
    expect(() => verify(gitWorktree(projectRoot, { isMainWorktree: false }))).toThrow(
      'must be the repository primary checkout'
    )
    expect(() => verify(gitWorktree(projectRoot), {}, true)).toThrow(
      'cannot adopt a sparse checkout'
    )
  })

  it('compares Windows checkout roots using runtime path semantics', () => {
    expect(
      verifyProvisionedRootCheckout({
        worktrees: [gitWorktree('c:/workspace/orca/')],
        sparseCheckoutEnabled: false,
        projectRoot: 'C:\\Workspace\\Orca',
        request: { name: 'fix-sandbox' }
      }).path
    ).toBe('c:/workspace/orca/')
  })
})
