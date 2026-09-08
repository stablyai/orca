import { beforeEach, describe, expect, it, vi } from 'vitest'
const { gh } = vi.hoisted(() => ({ gh: vi.fn() }))
vi.mock('../../gh-utils', () => ({ ghExecFileAsync: gh }))
import { getFallbackPRListForBranch, hydrateBranchLookupWithExactPR } from './pr-branch-lookup'
import { mapRestPullRequest } from './pull-request-lookup-data'

const repository = { owner: 'canonical', repo: 'repo', host: 'github.example.com' }
const actual = { owner: 'contributor', repo: 'other', host: repository.host }
const cli = {
  number: 42,
  title: 'Review',
  state: 'OPEN',
  url: 'https://github.example.com/canonical/repo/pull/42',
  statusCheckRollup: [],
  updatedAt: '',
  mergeable: 'UNKNOWN',
  headRefName: 'feature',
  headRepository: { name: 'other', nameWithOwner: 'contributor/other' },
  headRepositoryOwner: { login: 'contributor' }
}

describe('branch provider mapping and hydration', () => {
  beforeEach(() => {
    gh.mockReset()
  })

  it('requests and retains full actual identity from the CLI branch-list fallback', async () => {
    gh.mockResolvedValue({ stdout: JSON.stringify([cli]) })
    const data = await getFallbackPRListForBranch(repository, 'feature', {})
    expect(data?.headIdentity).toEqual({
      kind: 'resolved',
      repository: actual,
      branchName: 'feature'
    })
    expect(gh.mock.calls[0][0].at(-1)).toContain('headRepository,headRepositoryOwner')
    expect(gh.mock.calls[0][1]).toMatchObject({ host: repository.host })
    expect(data).not.toHaveProperty('reviewDecision')
  })

  it('retains CLI identity when GraphQL exact hydration fails', async () => {
    gh.mockResolvedValueOnce({ stdout: JSON.stringify([cli]) }).mockRejectedValue(
      new Error('GraphQL rate limit exceeded')
    )
    const data = await getFallbackPRListForBranch(repository, 'feature', {})
    expect(
      (await hydrateBranchLookupWithExactPR(repository, data, {}, 'local:host'))?.headIdentity
    ).toEqual(data?.headIdentity)
  })

  it('does not let successful GraphQL hydration erase a conflicting REST head repository', async () => {
    const data = mapRestPullRequest(
      {
        number: 42,
        title: '',
        state: 'open',
        head: { ref: 'feature', repo: { name: 'repo', owner: { login: 'contributor' } } }
      },
      repository
    )
    gh.mockResolvedValue({ stdout: JSON.stringify(cli) })
    const hydrated = await hydrateBranchLookupWithExactPR(repository, data, {}, 'local:host')
    expect(hydrated?.headIdentity).toEqual({
      kind: 'resolved',
      repository: actual,
      branchName: 'feature'
    })
  })
})
