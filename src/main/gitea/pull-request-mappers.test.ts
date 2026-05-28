import { describe, expect, it } from 'vitest'
import {
  deriveGiteaCommitStatus,
  mapGiteaMergeable,
  mapGiteaPullRequest,
  mapGiteaPullRequestState
} from './pull-request-mappers'

describe('Gitea pull request mappers', () => {
  it('maps pull request states', () => {
    expect(mapGiteaPullRequestState({ state: 'open' })).toBe('open')
    expect(mapGiteaPullRequestState({ state: 'closed' })).toBe('closed')
    expect(mapGiteaPullRequestState({ state: 'open', draft: true })).toBe('draft')
    expect(mapGiteaPullRequestState({ state: 'closed', merged: true })).toBe('merged')
  })

  it('maps mergeability', () => {
    expect(mapGiteaMergeable(true)).toBe('MERGEABLE')
    expect(mapGiteaMergeable(false)).toBe('CONFLICTING')
    expect(mapGiteaMergeable(undefined)).toBe('UNKNOWN')
  })

  it('derives commit status from the combined state', () => {
    expect(deriveGiteaCommitStatus({ state: 'success' })).toBe('success')
    expect(deriveGiteaCommitStatus({ state: 'failure' })).toBe('failure')
    expect(deriveGiteaCommitStatus({ state: 'error' })).toBe('failure')
    expect(deriveGiteaCommitStatus({ state: 'pending' })).toBe('pending')
    expect(deriveGiteaCommitStatus({ state: 'skipped' })).toBe('neutral')
  })

  it('rolls up individual statuses when the combined state is neutral', () => {
    expect(
      deriveGiteaCommitStatus({
        state: '',
        statuses: [{ status: 'success' }, { status: 'failure' }]
      })
    ).toBe('failure')
    expect(
      deriveGiteaCommitStatus({
        statuses: [{ status: 'success' }, { status: 'pending' }]
      })
    ).toBe('pending')
    expect(deriveGiteaCommitStatus({ statuses: [{ status: 'success' }] })).toBe('success')
    expect(deriveGiteaCommitStatus({ statuses: [] })).toBe('neutral')
  })

  it('maps a raw pull request to the hosted review shape', () => {
    expect(
      mapGiteaPullRequest(
        {
          number: 12,
          title: 'Gitea branch',
          state: 'open',
          html_url: 'https://git.example.com/team/project/pulls/12',
          updated_at: '2026-05-15T00:00:00Z',
          mergeable: true,
          head: { sha: 'abc123' }
        },
        'success'
      )
    ).toEqual({
      number: 12,
      title: 'Gitea branch',
      state: 'open',
      url: 'https://git.example.com/team/project/pulls/12',
      status: 'success',
      updatedAt: '2026-05-15T00:00:00Z',
      mergeable: 'MERGEABLE',
      headSha: 'abc123'
    })
  })

  it('rejects incomplete pull request payloads', () => {
    expect(mapGiteaPullRequest({ number: 1, title: 'missing url' }, 'neutral')).toBeNull()
  })
})
