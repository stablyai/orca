import { describe, expect, it } from 'vitest'
import {
  extractGitHubIssueSourceError,
  extractGitHubIssueSourceFallback
} from './github-work-item-source-errors'

describe('extractGitHubIssueSourceError', () => {
  it('keeps the failing issue source slug with the repo that produced it', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/orca' },
        {
          sources: { issues: { owner: 'upstream', repo: 'orca' } },
          errors: { issues: { message: 'HTTP 403: resource not accessible' } }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/orca',
      source: { owner: 'upstream', repo: 'orca' },
      message: 'HTTP 403: resource not accessible'
    })
  })

  it('drops issue errors when the source slug is unavailable', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/orca' },
        {
          sources: { issues: null },
          errors: { issues: { message: 'failed' } }
        }
      )
    ).toBeNull()
  })

  it('returns null when the envelope has no issue-side error', () => {
    expect(
      extractGitHubIssueSourceError(
        { id: 'repo-1', path: '/work/orca' },
        {
          sources: { issues: { owner: 'stablyai', repo: 'orca' } }
        }
      )
    ).toBeNull()
  })
})

describe('extractGitHubIssueSourceFallback', () => {
  it('reports the repo whose upstream issue source fell back to origin', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/orca', displayName: 'orca' },
        {
          issueSourceFellBack: true,
          sources: {
            issues: { owner: 'stablyai', repo: 'orca-fork' },
            prs: { owner: 'stablyai', repo: 'orca' }
          }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/orca',
      repoLabel: 'stablyai/orca'
    })
  })

  it('uses the Orca repo display name when the PR source is unavailable', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/orca', displayName: 'orca' },
        {
          issueSourceFellBack: true,
          sources: { issues: null, prs: null }
        }
      )
    ).toEqual({
      repoId: 'repo-1',
      repoPath: '/work/orca',
      repoLabel: 'orca'
    })
  })

  it('returns null when the source resolver did not fall back', () => {
    expect(
      extractGitHubIssueSourceFallback(
        { id: 'repo-1', path: '/work/orca', displayName: 'orca' },
        {
          sources: { issues: { owner: 'stablyai', repo: 'orca' } }
        }
      )
    ).toBeNull()
  })
})
