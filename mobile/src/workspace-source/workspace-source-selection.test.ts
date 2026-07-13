import { describe, expect, it } from 'vitest'
import {
  resolveBranchWorkspaceSource,
  resolveGitHubWorkspaceSource
} from './workspace-source-selection'

describe('workspace source selection', () => {
  it('uses deterministic GitHub identity when the title is not sluggable', () => {
    const source = resolveGitHubWorkspaceSource({
      id: 'pr-4',
      type: 'pr',
      number: 4,
      title: '你好',
      url: 'https://github.com/acme/app/pull/4',
      repoId: 'repo',
      state: 'open',
      labels: [],
      updatedAt: '',
      author: null
    })
    expect(source).toMatchObject({ suggestedName: 'pr-4', displayName: 'PR 4' })
  })

  it('offers exact reuse only for verified, non-busy local branches', () => {
    expect(
      resolveBranchWorkspaceSource({
        refName: 'feature/mobile',
        localBranchName: 'feature/mobile',
        verified: true,
        name: { value: '', owner: 'blank' },
        worktreeBranches: []
      })
    ).toMatchObject({ reuseEligibleBranch: 'feature/mobile', reuseEnabled: true })
    expect(
      resolveBranchWorkspaceSource({
        refName: 'feature/mobile',
        localBranchName: 'feature/mobile',
        verified: true,
        name: { value: '', owner: 'blank' },
        worktreeBranches: ['refs/heads/feature/mobile']
      })
    ).toMatchObject({ reuseEligibleBranch: null, branchNameOverride: undefined })
    expect(
      resolveBranchWorkspaceSource({
        refName: 'legacy',
        localBranchName: 'legacy',
        verified: false,
        name: { value: '', owner: 'blank' },
        worktreeBranches: []
      })
    ).toMatchObject({ reuseEligibleBranch: null, branchNameOverride: undefined })
  })
})
