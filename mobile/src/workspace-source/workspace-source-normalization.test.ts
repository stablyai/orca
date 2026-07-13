import { describe, expect, it } from 'vitest'
import {
  IncompatibleWorkspaceSourceResponseError,
  normalizeGitHubSourceResponse,
  normalizeLinearSourceResponse,
  normalizeRefSourceResponse
} from './workspace-source-normalization'

const githubItem = {
  id: 'I_1',
  type: 'issue',
  number: 8,
  title: 'Fix mobile selector',
  url: 'https://github.com/acme/app/issues/8'
}

describe('workspace source response normalization', () => {
  it('preserves GitHub rows beside issue-side partial errors and stamps the repo', () => {
    const result = normalizeGitHubSourceResponse(
      {
        items: [githubItem, { nope: true }],
        sources: { issues: null, prs: null },
        errors: { issues: { message: 'Issues unavailable' } }
      },
      'repo-current'
    )
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ kind: 'github', item: { repoId: 'repo-current' } })
    expect(result.warnings).toEqual(['Issues unavailable'])
  })

  it('rejects malformed top-level collections instead of reporting empty results', () => {
    expect(() => normalizeGitHubSourceResponse({ items: [] }, 'repo')).toThrow(
      IncompatibleWorkspaceSourceResponseError
    )
    expect(() => normalizeLinearSourceResponse({ errors: [] })).toThrow(
      IncompatibleWorkspaceSourceResponseError
    )
    expect(() => normalizeRefSourceResponse({})).toThrow(IncompatibleWorkspaceSourceResponseError)
  })

  it('accepts current and legacy Linear collections', () => {
    const issue = {
      id: 'linear-1',
      identifier: 'ENG-1',
      title: 'Ship selector',
      url: 'https://linear.app/acme/issue/ENG-1/ship-selector'
    }
    expect(normalizeLinearSourceResponse([issue]).rows).toHaveLength(1)
    expect(
      normalizeLinearSourceResponse({
        items: [issue],
        errors: [{ message: 'One workspace failed' }]
      }).warnings
    ).toEqual(['One workspace failed'])
  })

  it('marks legacy ref strings unverified so they can never imply reuse', () => {
    expect(
      normalizeRefSourceResponse({
        refDetails: [{ refName: 'main', localBranchName: 'main' }],
        refs: ['main', 'legacy']
      })
    ).toEqual([
      expect.objectContaining({ refName: 'main', verified: true }),
      expect.objectContaining({ refName: 'legacy', verified: false })
    ])
  })
})
