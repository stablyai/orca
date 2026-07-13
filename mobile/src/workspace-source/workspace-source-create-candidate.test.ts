import { describe, expect, it } from 'vitest'
import { buildWorkspaceSourceCreateCandidate } from './workspace-source-create-candidate'

describe('workspace source create candidates', () => {
  it('suffixes fresh workspace and PR branch overrides together', () => {
    expect(
      buildWorkspaceSourceCreateCandidate({
        baseParams: { setupDecision: 'inherit' },
        baseName: 'review-pr',
        name: { value: 'review-pr', owner: 'source' },
        selectedRepoId: 'repo',
        attempt: 1,
        source: {
          kind: 'github',
          item: { type: 'pr', number: 2 } as never,
          suggestedName: 'review-pr',
          displayName: 'Review PR 2',
          forkWarning: null,
          prStartPoint: { baseBranch: 'sha', branchNameOverride: 'feature/review' }
        }
      })
    ).toMatchObject({
      name: 'review-pr-2',
      linkedPR: 2,
      branchNameOverride: 'feature/review-2',
      displayName: 'Review PR 2'
    })
  })

  it('keeps verified exact branch reuse across name edits and retries', () => {
    expect(
      buildWorkspaceSourceCreateCandidate({
        baseParams: {},
        baseName: 'my-name',
        name: { value: 'my-name', owner: 'user' },
        selectedRepoId: 'repo',
        attempt: 2,
        source: {
          kind: 'branch',
          refName: 'feature/exact',
          localBranchName: 'feature/exact',
          verified: true,
          branchAutoName: 'feature/exact',
          branchNameOverride: 'feature/exact',
          reuseEligibleBranch: 'feature/exact',
          reuseEnabled: true
        }
      })
    ).toMatchObject({ name: 'my-name-3', branchNameOverride: 'feature/exact' })
  })
})
