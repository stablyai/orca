import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getWorkItem: vi.fn(),
  getWorkItemByOwnerRepo: vi.fn(),
  getProjectSlug: vi.fn(),
  getWorkItemByProjectRef: vi.fn(),
  getForgeProviderForRepository: vi.fn()
}))

vi.mock('../../../src/main/github/client', () => ({
  getWorkItem: mocks.getWorkItem,
  getWorkItemByOwnerRepo: mocks.getWorkItemByOwnerRepo
}))
vi.mock('../../../src/main/gitlab/merge-request-lookup', () => ({
  getProjectSlug: mocks.getProjectSlug
}))
vi.mock('../../../src/main/gitlab/work-item-queries', () => ({
  getWorkItemByProjectRef: mocks.getWorkItemByProjectRef
}))
vi.mock('../../../src/main/source-control/forge-provider', () => ({
  getForgeProviderForRepository: mocks.getForgeProviderForRepository
}))

import {
  LINEAGE_PR_LOOKUP_TIMEOUT_MS,
  lookupLineagePullRequestHeadBranch
} from '../../../src/main/lineage/lineage-pr-head-branch'

const repo = { id: 'r1', path: '/repos/api', displayName: 'api' }

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('lookupLineagePullRequestHeadBranch', () => {
  it('reads a GitHub PR through the URL owner, only from a configured remote', async () => {
    mocks.getWorkItemByOwnerRepo.mockResolvedValue({ type: 'pr', branchName: 'feat/a' })
    expect(
      await lookupLineagePullRequestHeadBranch(repo, {
        repoName: 'api',
        number: 3,
        provider: 'github',
        owner: 'my-org',
        host: 'github.com'
      })
    ).toBe('feat/a')
    expect(mocks.getWorkItemByOwnerRepo).toHaveBeenCalledWith(
      '/repos/api',
      { owner: 'my-org', repo: 'api', host: 'github.com' },
      3,
      'pr'
    )
    expect(mocks.getWorkItem).not.toHaveBeenCalled()
  })

  it('stores no branch when the GitHub URL owner is not a configured remote', async () => {
    mocks.getWorkItemByOwnerRepo.mockResolvedValue(null)
    mocks.getWorkItem.mockResolvedValue({ type: 'pr', branchName: 'wrong' })
    expect(
      await lookupLineagePullRequestHeadBranch(repo, {
        repoName: 'api',
        number: 12,
        provider: 'github',
        owner: 'other-org',
        host: 'github.com'
      })
    ).toBeNull()
    expect(mocks.getWorkItem).not.toHaveBeenCalled()
  })

  it('reads a GitLab MR only when the URL project is the repo project', async () => {
    mocks.getProjectSlug.mockResolvedValue({ host: 'gitlab.com', path: 'G/Api' })
    mocks.getWorkItemByProjectRef.mockResolvedValue({ branchName: 'feat/b' })
    expect(
      await lookupLineagePullRequestHeadBranch(repo, {
        repoName: 'api',
        number: 4,
        provider: 'gitlab',
        owner: 'g',
        host: 'gitlab.com'
      })
    ).toBe('feat/b')
    expect(mocks.getWorkItemByProjectRef).toHaveBeenCalledWith(
      '/repos/api',
      { host: 'gitlab.com', path: 'G/Api' },
      4,
      'mr'
    )
  })

  it('stores no branch when the GitLab URL project differs from the repo project', async () => {
    mocks.getProjectSlug.mockResolvedValue({ host: 'gitlab.com', path: 'g/api' })
    for (const pr of [
      { owner: 'other', host: 'gitlab.com' },
      { owner: 'g', host: 'gitlab.example.com' }
    ]) {
      expect(
        await lookupLineagePullRequestHeadBranch(repo, {
          repoName: 'api',
          number: 4,
          provider: 'gitlab',
          ...pr
        })
      ).toBeNull()
    }
    expect(mocks.getWorkItemByProjectRef).not.toHaveBeenCalled()
  })

  it('keeps repo#n on the local repo remotes, detecting the provider', async () => {
    mocks.getForgeProviderForRepository.mockResolvedValue({ id: 'github' })
    mocks.getWorkItem.mockResolvedValue({ type: 'pr', branchName: 'feat/c' })
    expect(await lookupLineagePullRequestHeadBranch(repo, { repoName: 'api', number: 5 })).toBe(
      'feat/c'
    )
    expect(mocks.getWorkItem).toHaveBeenCalledWith('/repos/api', 5, 'pr')
  })

  it('returns null for SSH repos, unsupported providers and failures', async () => {
    const pr = { repoName: 'api', number: 1 }
    expect(
      await lookupLineagePullRequestHeadBranch({ ...repo, connectionId: 'ssh-1' }, pr)
    ).toBeNull()
    expect(mocks.getForgeProviderForRepository).not.toHaveBeenCalled()
    mocks.getForgeProviderForRepository.mockResolvedValue({ id: 'bitbucket' })
    expect(await lookupLineagePullRequestHeadBranch(repo, pr)).toBeNull()
    mocks.getForgeProviderForRepository.mockResolvedValue({ id: 'github' })
    mocks.getWorkItem.mockRejectedValue(new Error('gh down'))
    expect(await lookupLineagePullRequestHeadBranch(repo, pr)).toBeNull()
  })

  it('gives up after the timeout so the add never waits on a hung provider', async () => {
    vi.useFakeTimers()
    mocks.getForgeProviderForRepository.mockResolvedValue({ id: 'github' })
    mocks.getWorkItem.mockReturnValue(new Promise(() => {}))
    const pending = lookupLineagePullRequestHeadBranch(repo, { repoName: 'api', number: 1 })
    await vi.advanceTimersByTimeAsync(LINEAGE_PR_LOOKUP_TIMEOUT_MS)
    expect(await pending).toBeNull()
    expect(LINEAGE_PR_LOOKUP_TIMEOUT_MS).toBe(5000)
  })
})
