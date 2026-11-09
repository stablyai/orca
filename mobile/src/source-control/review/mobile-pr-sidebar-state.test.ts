import { describe, expect, it } from 'vitest'
import type { PRInfo } from '../../../../src/shared/github/pull-request-types'
import { loadPrBranchReview, type PrSidebarLoadDeps } from './mobile-pr-sidebar-state'

const linkedPR: PRInfo = {
  number: 5,
  title: 'Linked',
  state: 'open',
  url: 'https://github.com/o/r/pull/5',
  checksStatus: 'neutral',
  updatedAt: '2026-11-09T00:00:00Z',
  mergeable: 'MERGEABLE'
}

describe('loadPrBranchReview', () => {
  it('stops falling back to a PR read under a link the workspace no longer has', async () => {
    const sent: { fallbackPRNumber?: number | null }[] = []
    const deps: PrSidebarLoadDeps = {
      fetchForBranch: async () => ({
        ok: true,
        result: {
          provider: 'github',
          number: 12,
          title: 'Branch PR',
          state: 'open',
          url: 'https://github.com/o/r/pull/12',
          status: 'neutral',
          updatedAt: '2026-11-09T00:00:00Z',
          mergeable: 'MERGEABLE'
        }
      }),
      fetchWorktreeGitHubPRLink: async () => ({
        linkedPR: null,
        suppressedGitHubPR: null,
        pushTarget: null
      }),
      clearWorktreeReviewLink: async () => {},
      fetchPRForBranch: async (_worktreeId, args) => {
        sent.push(args)
        return { ok: true, result: null }
      }
    }
    await loadPrBranchReview(deps, {
      worktreeId: 'repo::/w',
      branch: 'feature',
      headSha: 'head-1',
      previous: { kind: 'found', pr: linkedPR, pushTarget: null, linkedPRNumber: 5 }
    })
    expect(sent.map((args) => args.fallbackPRNumber)).toEqual([12])
  })
})
