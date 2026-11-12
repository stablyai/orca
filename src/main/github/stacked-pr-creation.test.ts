import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, repositoryMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  repositoryMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  acquire: vi.fn(),
  release: vi.fn(),
  ghExecFileAsync: ghExecFileAsyncMock,
  ghRepoExecOptions: (context: { repoPath: string; connectionId?: string | null }) =>
    context.connectionId ? {} : { cwd: context.repoPath },
  githubRepoContext: (
    repoPath: string,
    connectionId?: string | null,
    localGitOptions?: Record<string, unknown>
  ) => ({ repoPath, connectionId, localGitOptions })
}))

vi.mock('./github-api-repository', () => ({
  getOriginGitHubApiRepository: repositoryMock,
  githubHostExecOptions: (repository: { host?: string }) => ({ host: repository.host })
}))

import {
  prepareGitHubStackedPullRequest,
  registerGitHubStackedPullRequest
} from './stacked-pr-creation'

const repository = { owner: 'acme', repo: 'orca', host: 'github.com' }
const parentReview = { number: 41, url: 'https://github.com/acme/orca/pull/41' }
const currentReview = { number: 42, url: 'https://github.com/acme/orca/pull/42' }

function pullRequest(number: number, head: string, base: string) {
  return {
    number,
    html_url: `https://github.com/acme/orca/pull/${number}`,
    head: { ref: head },
    base: { ref: base }
  }
}

function stack(number: number, pullRequests: number[]) {
  return {
    number,
    open: true,
    pull_requests: pullRequests.map((pullRequestNumber) => ({ number: pullRequestNumber }))
  }
}

beforeEach(() => {
  ghExecFileAsyncMock.mockReset()
  repositoryMock.mockReset()
  repositoryMock.mockResolvedValue(repository)
})

describe('prepareGitHubStackedPullRequest', () => {
  it('allows an idempotent retry after the child was already registered', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([pullRequest(41, 'stack/parent', 'main')]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([pullRequest(42, 'stack/child', 'stack/parent')])
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [41, 42])]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [41, 42])]) })

    const result = await prepareGitHubStackedPullRequest(
      '/repo',
      {
        provider: 'github',
        base: 'stack/parent',
        head: 'stack/child',
        title: 'Child'
      },
      'local'
    )

    expect(result).toMatchObject({ ok: true, currentReview: { number: 42 } })
  })

  it('rejects a parent that is not the top of its stack', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([pullRequest(41, 'stack/parent', 'main')]) })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [41, 45])]) })

    const result = await prepareGitHubStackedPullRequest(
      '/repo',
      {
        provider: 'github',
        base: 'stack/parent',
        head: 'stack/child',
        title: 'Child'
      },
      'local'
    )

    expect(result).toMatchObject({ ok: false, code: 'validation' })
    if (!result.ok) {
      expect(result.error).toContain('top pull request')
    }
  })
})

describe('registerGitHubStackedPullRequest', () => {
  it('treats an already registered parent-child pair as success', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [41, 42])]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [41, 42])]) })

    const result = await registerGitHubStackedPullRequest({
      executionHostId: 'local',
      repoPath: '/repo',
      repository,
      parentReview,
      currentReview
    })

    expect(result).toMatchObject({ ok: true, stackNumber: 50 })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not claim registration when the stack no longer holds the parent', async () => {
    // A missing parent gives -1; reading its successor would falsely identify the first entry as its child.
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [42])]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [42])]) })

    const result = await registerGitHubStackedPullRequest({
      executionHostId: 'local',
      repoPath: '/repo',
      repository,
      parentReview,
      currentReview
    })

    expect(result).toMatchObject({
      ok: false,
      error: 'The pull request already belongs to a different GitHub stack.',
      reason: 'stack_conflict',
      createdReview: currentReview
    })
  })

  it('preserves the created PR when registration fails', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockRejectedValueOnce(new Error('HTTP 422'))

    const result = await registerGitHubStackedPullRequest({
      executionHostId: 'local',
      repoPath: '/repo',
      repository,
      parentReview,
      currentReview
    })

    expect(result).toMatchObject({
      ok: false,
      createdReview: currentReview
    })
  })
})
