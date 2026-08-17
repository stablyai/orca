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
  it('resolves an open parent PR and an existing current PR', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([pullRequest(41, 'stack/parent', 'main')]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([pullRequest(42, 'stack/child', 'stack/parent')])
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [40, 41])]) })
      .mockResolvedValueOnce({ stdout: '[]' })

    const result = await prepareGitHubStackedPullRequest('/repo', {
      provider: 'github',
      base: 'origin/stack/parent',
      head: 'refs/heads/stack/child',
      title: 'Child'
    })

    expect(result).toMatchObject({
      ok: true,
      parentReview: { number: 41 },
      currentReview: { number: 42 }
    })
    expect(ghExecFileAsyncMock.mock.calls[0][0]).toEqual([
      'api',
      'repos/acme/orca/pulls?head=acme%3Astack%2Fparent&state=open&per_page=2'
    ])
    expect(ghExecFileAsyncMock.mock.calls[1][0]).toEqual([
      'api',
      'repos/acme/orca/pulls?head=acme%3Astack%2Fchild&base=stack%2Fparent&state=open&per_page=2'
    ])
  })

  it('allows an idempotent retry after the child was already registered', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([pullRequest(41, 'stack/parent', 'main')]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([pullRequest(42, 'stack/child', 'stack/parent')])
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [41, 42])]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [41, 42])]) })

    const result = await prepareGitHubStackedPullRequest('/repo', {
      provider: 'github',
      base: 'stack/parent',
      head: 'stack/child',
      title: 'Child'
    })

    expect(result).toMatchObject({ ok: true, currentReview: { number: 42 } })
  })

  it('requires an open PR for the selected parent branch', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: '[]' })

    const result = await prepareGitHubStackedPullRequest('/repo', {
      provider: 'github',
      base: 'feature/parent',
      head: 'feature/child',
      title: 'Child'
    })

    expect(result).toMatchObject({ ok: false, code: 'validation' })
    if (!result.ok) {
      expect(result.error).toContain('does not have an open pull request')
    }
  })

  it('rejects a parent that is not the top of its stack', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([pullRequest(41, 'stack/parent', 'main')]) })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [41, 45])]) })

    const result = await prepareGitHubStackedPullRequest('/repo', {
      provider: 'github',
      base: 'stack/parent',
      head: 'stack/child',
      title: 'Child'
    })

    expect(result).toMatchObject({ ok: false, code: 'validation' })
    if (!result.ok) {
      expect(result.error).toContain('top pull request')
    }
  })

  it('does not offer stacks on GitHub Enterprise Server', async () => {
    repositoryMock.mockResolvedValue({
      owner: 'acme',
      repo: 'orca',
      host: 'github.acme.test'
    })

    const result = await prepareGitHubStackedPullRequest('/repo', {
      provider: 'github',
      base: 'stack/parent',
      head: 'stack/child',
      title: 'Child'
    })

    expect(result).toMatchObject({ ok: false, code: 'validation' })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })
})

describe('registerGitHubStackedPullRequest', () => {
  it('creates a new stack with the parent and current PR', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ number: 50 }) })

    const result = await registerGitHubStackedPullRequest({
      repoPath: '/repo',
      repository,
      parentReview,
      currentReview
    })

    expect(result).toMatchObject({ ok: true, number: 42, stackNumber: 50 })
    expect(ghExecFileAsyncMock.mock.calls[2][0]).toEqual([
      'api',
      '-X',
      'POST',
      'repos/acme/orca/stacks',
      '-F',
      'pull_requests[]=41',
      '-F',
      'pull_requests[]=42'
    ])
  })

  it('appends the current PR when the parent is the existing top', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [40, 41])]) })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ number: 50 }) })

    const result = await registerGitHubStackedPullRequest({
      repoPath: '/repo',
      repository,
      parentReview,
      currentReview,
      connectionId: 'ssh-1'
    })

    expect(result).toMatchObject({ ok: true, stackNumber: 50 })
    expect(ghExecFileAsyncMock.mock.calls[2][0]).toEqual([
      'api',
      '-X',
      'POST',
      'repos/acme/orca/stacks/50/add',
      '-F',
      'pull_requests[]=42'
    ])
    expect(ghExecFileAsyncMock.mock.calls[2][1]).not.toHaveProperty('cwd')
  })

  it('treats an already registered parent-child pair as success', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [41, 42])]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [41, 42])]) })

    const result = await registerGitHubStackedPullRequest({
      repoPath: '/repo',
      repository,
      parentReview,
      currentReview
    })

    expect(result).toMatchObject({ ok: true, stackNumber: 50 })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not claim registration when the stack no longer holds the parent', async () => {
    // A concurrent stack edit can drop the parent while the child sits at index 0.
    // Reading index 0 off a findIndex miss would report that pair as registered.
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [42])]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([stack(50, [42])]) })

    const result = await registerGitHubStackedPullRequest({
      repoPath: '/repo',
      repository,
      parentReview,
      currentReview
    })

    expect(result).toMatchObject({
      ok: false,
      error: 'The pull request already belongs to a different GitHub stack.',
      createdReview: currentReview
    })
  })

  it('preserves the created PR when registration fails', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockRejectedValueOnce(new Error('HTTP 422'))

    const result = await registerGitHubStackedPullRequest({
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
