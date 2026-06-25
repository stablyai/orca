import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createAzureDevOpsPullRequest,
  isAzureDevOpsReviewCreationAuthenticated
} from './pull-request-creation'
import { _resetAzureDevOpsRepoRefCache } from './repository-ref'

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

describe('Azure DevOps pull request creation', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    gitExecFileAsyncMock.mockReset()
    getSshGitProviderMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://dev.azure.com/acme/Project/_git/repo\n',
      stderr: ''
    })
    _resetAzureDevOpsRepoRefCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
    _resetAzureDevOpsRepoRefCache()
  })

  it('treats token-only auth as sufficient for repo-scoped creation', () => {
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
    expect(isAzureDevOpsReviewCreationAuthenticated()).toBe(true)
  })

  it('posts a pull request create body to the repository REST endpoint', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.pathname).toBe('/acme/Project/_apis/git/repositories/repo/pullRequests')
      expect(url.searchParams.get('api-version')).toBe('7.1')
      expect(init).toBeDefined()
      const requestInit = init!
      expect(requestInit.method).toBe('POST')
      expect((requestInit.headers as Record<string, string>).Authorization).toMatch(/^Basic /)
      expect(JSON.parse(String(requestInit.body))).toEqual({
        sourceRefName: 'refs/heads/feature/azure',
        targetRefName: 'refs/heads/main',
        title: 'Add Azure create',
        description: 'Body',
        isDraft: true
      })
      return Response.json({
        pullRequestId: 37,
        title: 'Add Azure create',
        status: 'active',
        isDraft: true,
        creationDate: '2026-06-01T00:00:00Z',
        _links: {
          web: {
            href: 'https://dev.azure.com/acme/Project/_git/repo/pullrequest/37'
          }
        }
      })
    })
    globalThis.fetch = fetchMock as never

    await expect(
      createAzureDevOpsPullRequest('/repo', {
        provider: 'azure-devops',
        base: 'origin/main',
        head: 'refs/heads/feature/azure',
        title: 'Add Azure create',
        body: 'Body',
        draft: true
      })
    ).resolves.toEqual({
      ok: true,
      number: 37,
      url: 'https://dev.azure.com/acme/Project/_git/repo/pullrequest/37'
    })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('resolves Azure DevOps remotes through the SSH git provider', async () => {
    const remoteGit = {
      exec: vi.fn(async () => ({
        stdout: 'git@ssh.dev.azure.com:v3/acme/Project/repo.git\n',
        stderr: ''
      }))
    }
    getSshGitProviderMock.mockReturnValue(remoteGit)
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        pullRequestId: 38,
        title: 'Remote Azure create',
        status: 'active',
        creationDate: '2026-06-01T00:00:00Z'
      })
    ) as never

    await expect(
      createAzureDevOpsPullRequest(
        '/remote/repo',
        {
          provider: 'azure-devops',
          base: 'main',
          head: 'feature/azure',
          title: 'Remote Azure create'
        },
        'ssh-1'
      )
    ).resolves.toMatchObject({
      ok: true,
      number: 38
    })
    expect(remoteGit.exec).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], '/remote/repo')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('classifies auth failures without retrying shell commands', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ message: 'Unauthorized' }, { status: 401 })
    ) as never

    await expect(
      createAzureDevOpsPullRequest('/repo', {
        provider: 'azure-devops',
        base: 'main',
        head: 'feature/azure',
        title: 'Add Azure create'
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'auth_required'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
  })
})
