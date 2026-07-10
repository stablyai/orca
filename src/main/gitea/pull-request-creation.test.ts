import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGiteaPullRequest, isGiteaReviewCreationAuthenticated } from './pull-request-creation'
import { _resetGiteaRepoRefCache } from './repository-ref'

const { gitExecFileAsyncMock, getSshGitProviderMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  getSshGitProviderMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

vi.mock('../source-control/pull-request-template', () => ({
  readHostedPullRequestTemplate: vi.fn(async () => 'Template body')
}))

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch

describe('Gitea pull request creation', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_GITEA_TOKEN: 'gitea-token' }
    gitExecFileAsyncMock.mockReset()
    getSshGitProviderMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://git.example.com/code/team/repo.git\n',
      stderr: ''
    })
    _resetGiteaRepoRefCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
    _resetGiteaRepoRefCache()
  })

  it('requires a token for repo-scoped creation', () => {
    expect(isGiteaReviewCreationAuthenticated()).toBe(true)
    delete process.env.ORCA_GITEA_TOKEN
    expect(isGiteaReviewCreationAuthenticated()).toBe(false)
  })

  it('posts a pull request create body to the repository REST endpoint', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.origin).toBe('https://git.example.com')
      expect(url.pathname).toBe('/code/api/v1/repos/team/repo/pulls')
      expect(init).toBeDefined()
      const requestInit = init!
      expect(requestInit.method).toBe('POST')
      expect((requestInit.headers as Record<string, string>).Authorization).toBe(
        'token gitea-token'
      )
      expect(JSON.parse(String(requestInit.body))).toEqual({
        base: 'main',
        head: 'feature/gitea',
        title: 'Add Gitea create',
        body: 'Body',
        draft: true
      })
      return Response.json({
        number: 13,
        title: 'Add Gitea create',
        state: 'open',
        draft: true,
        html_url: 'https://git.example.com/code/team/repo/pulls/13',
        updated_at: '2026-06-01T00:00:00Z',
        mergeable: true,
        head: {
          ref: 'feature/gitea',
          sha: 'abc123'
        }
      })
    })
    globalThis.fetch = fetchMock as never

    await expect(
      createGiteaPullRequest('/repo', {
        provider: 'gitea',
        base: 'origin/main',
        head: 'refs/heads/feature/gitea',
        title: 'Add Gitea create',
        body: 'Body',
        draft: true
      })
    ).resolves.toEqual({
      ok: true,
      number: 13,
      url: 'https://git.example.com/code/team/repo/pulls/13'
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('resolves Gitea remotes through the SSH git provider', async () => {
    const remoteGit = {
      exec: vi.fn(async () => ({
        stdout: 'git@git.example.com:code/team/repo.git\n',
        stderr: ''
      }))
    }
    getSshGitProviderMock.mockReturnValue(remoteGit)
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        number: 14,
        title: 'Remote Gitea create',
        state: 'open',
        html_url: 'https://git.example.com/code/team/repo/pulls/14',
        updated_at: '2026-06-01T00:00:00Z',
        mergeable: true
      })
    ) as never

    await expect(
      createGiteaPullRequest(
        '/remote/repo',
        {
          provider: 'gitea',
          base: 'main',
          head: 'feature/gitea',
          title: 'Remote Gitea create'
        },
        'ssh-1'
      )
    ).resolves.toMatchObject({
      ok: true,
      number: 14
    })
    expect(remoteGit.exec).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], '/remote/repo')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('classifies validation failures from the REST API', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ message: 'Validation failed' }, { status: 422 })
    ) as never

    await expect(
      createGiteaPullRequest('/repo', {
        provider: 'gitea',
        base: 'main',
        head: 'feature/gitea',
        title: 'Add Gitea create'
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'validation'
    })
  })
})
