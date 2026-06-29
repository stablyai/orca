import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAzureDevOpsAuthStatus,
  getAzureDevOpsPullRequestForBranch,
  normalizeAzureDevOpsApiBaseUrl
} from './client'
import { _resetAzCliTokenCache } from './az-cli-token'
import { _resetAzureDevOpsRepoRefCache } from './repository-ref'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())
const { execLocalPreflightCommandMock, isCommandAvailableMock } = vi.hoisted(() => ({
  execLocalPreflightCommandMock: vi.fn(),
  isCommandAvailableMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../ipc/preflight-command-exec', () => ({
  execLocalPreflightCommand: execLocalPreflightCommandMock,
  isCommandAvailable: isCommandAvailableMock
}))

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch

describe('Azure DevOps client', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    gitExecFileAsyncMock.mockReset()
    execLocalPreflightCommandMock.mockReset()
    isCommandAvailableMock.mockReset()
    _resetAzureDevOpsRepoRefCache()
    _resetAzCliTokenCache()
  })

  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
    _resetAzureDevOpsRepoRefCache()
    _resetAzCliTokenCache()
  })

  it('normalizes configured API base URLs', () => {
    expect(normalizeAzureDevOpsApiBaseUrl('https://dev.azure.com/acme/Project/_apis/')).toBe(
      'https://dev.azure.com/acme/Project'
    )
  })

  it('marks token-only auth as configured but unverified because repository remotes supply the API base URL', async () => {
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
    await expect(getAzureDevOpsAuthStatus()).resolves.toEqual({
      configured: true,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: true
    })
  })

  it('reports az-only auth as configured and authenticated when local az can mint a token', async () => {
    process.env = {
      ...OLD_ENV,
      ORCA_AZURE_DEVOPS_API_BASE_URL: 'https://dev.azure.com/acme'
    }
    delete process.env.ORCA_AZURE_DEVOPS_TOKEN
    delete process.env.ORCA_AZURE_DEVOPS_PAT
    delete process.env.ORCA_AZURE_DEVOPS_ACCESS_TOKEN
    execLocalPreflightCommandMock.mockResolvedValue({
      stdout: JSON.stringify({
        accessToken: 'az-token',
        expires_on: Math.floor(Date.now() / 1000) + 3600
      }),
      stderr: ''
    })
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer az-token')
      return Response.json({
        authenticatedUser: {
          providerDisplayName: 'Ada Azure'
        }
      })
    }) as never

    await expect(getAzureDevOpsAuthStatus({ localAzAvailable: true })).resolves.toEqual({
      configured: true,
      authenticated: true,
      account: 'Ada Azure',
      baseUrl: 'https://dev.azure.com/acme',
      tokenConfigured: true
    })
    expect(execLocalPreflightCommandMock).toHaveBeenCalledOnce()
  })

  it('does not spawn az when local az is unavailable and no env token is set', async () => {
    process.env = { ...OLD_ENV }
    delete process.env.ORCA_AZURE_DEVOPS_TOKEN
    delete process.env.ORCA_AZURE_DEVOPS_PAT
    delete process.env.ORCA_AZURE_DEVOPS_ACCESS_TOKEN
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL

    await expect(getAzureDevOpsAuthStatus({ localAzAvailable: false })).resolves.toEqual({
      configured: false,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false
    })
    expect(execLocalPreflightCommandMock).not.toHaveBeenCalled()
  })

  it('resolves a PR for a branch through repository, PR, and status REST calls', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://dev.azure.com/acme/Project/_git/repo\n'
    })
    const requests: { pathname: string; search: string; authorization: string | null }[] = []
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      requests.push({
        pathname: url.pathname,
        search: url.search,
        authorization: null
      })
      const response = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })

      if (url.pathname === '/acme/Project/_apis/git/repositories/repo') {
        return response({
          id: 'repo-guid',
          webUrl: 'https://dev.azure.com/acme/Project/_git/repo'
        })
      }
      if (url.pathname === '/acme/Project/_apis/git/repositories/repo-guid/pullRequests') {
        expect(url.searchParams.get('searchCriteria.sourceRefName')).toBe(
          'refs/heads/feature/azure'
        )
        expect(url.searchParams.get('searchCriteria.status')).toBe('all')
        return response({
          value: [
            {
              pullRequestId: 17,
              title: 'Old Azure PR',
              status: 'completed',
              creationDate: '2026-05-10T00:00:00Z',
              lastMergeSourceCommit: { commitId: 'oldsha' }
            },
            {
              pullRequestId: 18,
              title: 'Azure branch',
              status: 'active',
              creationDate: '2026-05-11T00:00:00Z',
              mergeStatus: 'succeeded',
              lastMergeSourceCommit: { commitId: 'abc123' }
            }
          ]
        })
      }
      if (
        url.pathname === '/acme/Project/_apis/git/repositories/repo-guid/pullRequests/18/statuses'
      ) {
        return response({ value: [{ state: 'succeeded' }] })
      }
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
    }) as never

    await expect(
      getAzureDevOpsPullRequestForBranch('/repo', 'refs/heads/feature/azure')
    ).resolves.toEqual({
      number: 18,
      title: 'Azure branch',
      state: 'open',
      url: 'https://dev.azure.com/acme/Project/_git/repo/pullrequest/18',
      status: 'success',
      updatedAt: '2026-05-11T00:00:00Z',
      mergeable: 'MERGEABLE',
      headSha: 'abc123'
    })
    expect(requests.map((request) => request.pathname)).toEqual([
      '/acme/Project/_apis/git/repositories/repo',
      '/acme/Project/_apis/git/repositories/repo-guid/pullRequests',
      '/acme/Project/_apis/git/repositories/repo-guid/pullRequests/18/statuses'
    ])
  })

  it('uses the most recent branch PR instead of preferring stale active PRs', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://dev.azure.com/acme/Project/_git/repo\n'
    })
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      const response = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })

      if (url.pathname === '/acme/Project/_apis/git/repositories/repo') {
        return response({ id: 'repo-guid' })
      }
      if (url.pathname === '/acme/Project/_apis/git/repositories/repo-guid/pullRequests') {
        return response({
          value: [
            {
              pullRequestId: 20,
              title: 'Stale active PR',
              status: 'active',
              creationDate: '2026-05-10T00:00:00Z',
              mergeStatus: 'succeeded',
              lastMergeSourceCommit: { commitId: 'oldsha' }
            },
            {
              pullRequestId: 21,
              title: 'Latest completed PR',
              status: 'completed',
              creationDate: '2026-05-15T00:00:00Z',
              closedDate: '2026-05-16T00:00:00Z',
              mergeStatus: 'succeeded',
              lastMergeSourceCommit: { commitId: 'newsha' }
            }
          ]
        })
      }
      if (
        url.pathname === '/acme/Project/_apis/git/repositories/repo-guid/pullRequests/21/statuses'
      ) {
        return response({ value: [{ state: 'succeeded' }] })
      }
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
    }) as never

    await expect(
      getAzureDevOpsPullRequestForBranch('/repo', 'refs/heads/feature/azure')
    ).resolves.toMatchObject({
      number: 21,
      title: 'Latest completed PR',
      state: 'merged',
      headSha: 'newsha'
    })
  })
})
