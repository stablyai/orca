import { describe, expect, it } from 'vitest'
import {
  getSelectedReviewBranch,
  getSelectedReviewLookupHints,
  isAllowedPushTargetRemoteConflict,
  isMatchingSelectedGitHubPr,
  type SelectedReviewBranchInput
} from './selected-review-branch'

// characterization: current behavior

const PROVIDER_CASES: {
  label: string
  input: SelectedReviewBranchInput
  expected: { provider: string; number: number } | null
}[] = [
  { label: 'no linked review', input: {}, expected: null },
  { label: 'github', input: { linkedPR: 7 }, expected: { provider: 'github', number: 7 } },
  {
    label: 'gitlab',
    input: { linkedGitLabMR: 12 },
    expected: { provider: 'gitlab', number: 12 }
  },
  {
    label: 'bitbucket',
    input: { linkedBitbucketPR: 3 },
    expected: { provider: 'bitbucket', number: 3 }
  },
  {
    label: 'azure devops',
    input: { linkedAzureDevOpsPR: 44 },
    expected: { provider: 'azure-devops', number: 44 }
  },
  { label: 'gitea', input: { linkedGiteaPR: 9 }, expected: { provider: 'gitea', number: 9 } },
  {
    label: 'zero is a real number',
    input: { linkedPR: 0 },
    expected: { provider: 'github', number: 0 }
  },
  {
    label: 'null linked ids are skipped',
    input: { linkedPR: null, linkedGitLabMR: null },
    expected: null
  },
  {
    label: 'github wins over gitlab when both are set',
    input: { linkedPR: 1, linkedGitLabMR: 2 },
    expected: { provider: 'github', number: 1 }
  },
  {
    label: 'gitlab wins over bitbucket when both are set',
    input: { linkedGitLabMR: 2, linkedBitbucketPR: 3 },
    expected: { provider: 'gitlab', number: 2 }
  }
]

describe('getSelectedReviewBranch', () => {
  it.each(PROVIDER_CASES)('resolves $label', ({ input, expected }) => {
    expect(getSelectedReviewBranch(input)).toEqual(expected)
  })
})

type ExistingPr = Parameters<typeof isMatchingSelectedGitHubPr>[0]

const pr = (number: number): ExistingPr => ({ number }) as ExistingPr

describe('isMatchingSelectedGitHubPr', () => {
  it('matches when the PR number and the branch override both line up', () => {
    expect(
      isMatchingSelectedGitHubPr(pr(7), { linkedPR: 7, branchNameOverride: 'feat' }, 'feat')
    ).toBe(true)
  })

  it('rejects a different PR number', () => {
    expect(
      isMatchingSelectedGitHubPr(pr(8), { linkedPR: 7, branchNameOverride: 'feat' }, 'feat')
    ).toBe(false)
  })

  it('rejects when the branch override does not equal the branch', () => {
    expect(
      isMatchingSelectedGitHubPr(pr(7), { linkedPR: 7, branchNameOverride: 'other' }, 'feat')
    ).toBe(false)
  })

  it('rejects when there is no branch override at all', () => {
    expect(isMatchingSelectedGitHubPr(pr(7), { linkedPR: 7 }, 'feat')).toBe(false)
  })

  it('rejects a non-GitHub selection even when the branch override matches', () => {
    expect(
      isMatchingSelectedGitHubPr(pr(7), { linkedGitLabMR: 7, branchNameOverride: 'feat' }, 'feat')
    ).toBe(false)
  })

  it('returns false for a null existing PR', () => {
    expect(
      isMatchingSelectedGitHubPr(null, { linkedPR: 7, branchNameOverride: 'feat' }, 'feat')
    ).toBe(false)
  })
})

describe('isAllowedPushTargetRemoteConflict', () => {
  const args: SelectedReviewBranchInput = {
    linkedGitLabMR: 12,
    branchNameOverride: 'feat',
    pushTarget: { remoteName: 'origin', branchName: 'feat' }
  }

  it('allows a remote conflict on the selected review branch', () => {
    expect(isAllowedPushTargetRemoteConflict('remote', 'feat', args)).toBe(true)
  })

  it('does not allow a local conflict', () => {
    expect(isAllowedPushTargetRemoteConflict('local', 'feat', args)).toBe(false)
  })

  it('does not allow a null conflict kind', () => {
    expect(isAllowedPushTargetRemoteConflict(null, 'feat', args)).toBe(false)
  })

  it('requires a linked review', () => {
    expect(
      isAllowedPushTargetRemoteConflict('remote', 'feat', {
        branchNameOverride: 'feat',
        pushTarget: args.pushTarget
      })
    ).toBe(false)
  })

  it('requires the push target to name the same branch', () => {
    expect(
      isAllowedPushTargetRemoteConflict('remote', 'feat', {
        ...args,
        pushTarget: { remoteName: 'origin', branchName: 'elsewhere' }
      })
    ).toBe(false)
  })

  it('requires a push target', () => {
    expect(
      isAllowedPushTargetRemoteConflict('remote', 'feat', {
        linkedGitLabMR: 12,
        branchNameOverride: 'feat'
      })
    ).toBe(false)
  })
})

describe('getSelectedReviewLookupHints', () => {
  it('normalizes every absent hint to null', () => {
    expect(getSelectedReviewLookupHints({})).toEqual({
      linkedGitHubPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })
  })

  it('renames linkedPR to linkedGitHubPR and passes the rest through', () => {
    expect(
      getSelectedReviewLookupHints({
        linkedPR: 7,
        linkedGitLabMR: 12,
        linkedBitbucketPR: 3,
        linkedAzureDevOpsPR: 44,
        linkedGiteaPR: 9
      })
    ).toEqual({
      linkedGitHubPR: 7,
      linkedGitLabMR: 12,
      linkedBitbucketPR: 3,
      linkedAzureDevOpsPR: 44,
      linkedGiteaPR: 9
    })
  })

  it('keeps 0 rather than coercing it to null', () => {
    expect(getSelectedReviewLookupHints({ linkedPR: 0 }).linkedGitHubPR).toBe(0)
  })
})
