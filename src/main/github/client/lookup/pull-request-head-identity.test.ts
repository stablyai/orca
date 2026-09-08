import { describe, expect, it } from 'vitest'
import { readPullRequestHeadIdentity, matchesPullRequestHead } from './pull-request-head-identity'
import { mapRestPullRequest, normalizePullRequestLookupData } from './pull-request-lookup-data'

const expected = { owner: 'contributor', repo: 'repo', host: 'github.example.com' }
const fields = {
  url: 'https://github.example.com/canonical/repo/pull/42',
  headRefName: 'feature',
  headRepository: { name: 'repo', nameWithOwner: 'contributor/repo' },
  headRepositoryOwner: { login: 'contributor' }
}

describe('provider head identity evidence', () => {
  it('retains Enterprise GraphQL/CLI identity using the executing API host', () => {
    expect(readPullRequestHeadIdentity(fields, expected)).toEqual({
      kind: 'resolved',
      repository: expected,
      branchName: 'feature'
    })
  })

  it('derives ambient CLI host from the returned PR URL, not local configuration', () => {
    expect(readPullRequestHeadIdentity(fields)).toMatchObject({ repository: expected })
  })

  it.each([
    { ...expected, repo: 'other' },
    { ...expected, owner: 'stranger' },
    { ...expected, host: 'github.com' }
  ])('does not collapse a full repository identity into owner equality: %j', (other) => {
    expect(matchesPullRequestHead(readPullRequestHeadIdentity(fields), other, 'feature')).toBe(
      false
    )
  })

  it('uses case-insensitive repository identity and case-sensitive branch identity', () => {
    const identity = readPullRequestHeadIdentity(fields)
    expect(
      matchesPullRequestHead(
        identity,
        { owner: 'CONTRIBUTOR', repo: 'REPO', host: 'GITHUB.EXAMPLE.COM' },
        'feature'
      )
    ).toBe(true)
    expect(matchesPullRequestHead(identity, expected, 'Feature')).toBe(false)
  })

  it('retains the REST head host even when it differs from the query host', () => {
    const mapped = mapRestPullRequest(
      {
        number: 42,
        title: '',
        state: 'open',
        head: {
          ref: 'feature',
          repo: {
            name: 'repo',
            owner: { login: 'contributor' },
            html_url: 'https://github.com/contributor/repo'
          }
        }
      },
      expected
    )
    expect(mapped.headIdentity).toMatchObject({ repository: { host: 'github.com' } })
    expect(matchesPullRequestHead(mapped.headIdentity, expected, 'feature')).toBe(false)
  })

  it.each([
    { ...fields, headRepository: undefined },
    { ...fields, headRepository: { name: 'repo' }, headRepositoryOwner: null },
    { ...fields, headRefName: undefined },
    { ...fields, headRepository: { name: 'other', nameWithOwner: 'contributor/repo' } },
    { ...fields, headRepository: { name: 'repo', html_url: 'https://github.com/stranger/repo' } }
  ])('keeps incomplete or inconsistent identity unverifiable: %j', (data) => {
    expect(readPullRequestHeadIdentity(data)).toEqual({ kind: 'unverifiable', reason: 'missing' })
  })

  it('preserves explicit deletion through REST mapping and normalization', () => {
    const mapped = mapRestPullRequest(
      { number: 42, title: '', state: 'open', head: { ref: 'feature', repo: null } },
      expected
    )
    expect(normalizePullRequestLookupData(mapped).headIdentity).toEqual({
      kind: 'unverifiable',
      reason: 'deleted'
    })
    expect(matchesPullRequestHead(mapped.headIdentity, expected, 'feature')).toBe(false)
  })
})
