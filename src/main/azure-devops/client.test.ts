import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelTrackingResponse } from '../lib/unread-response-body.test-fixtures'
import {
  getAzureDevOpsAuthStatus,
  getAzureDevOpsPullRequestForBranch,
  getAzureDevOpsPullRequestForBranchOrThrow,
  normalizeAzureDevOpsApiBaseUrl
} from './client'
import { _resetAzureDevOpsRepoRefCache } from './repository-ref'
import { __resetRepoDefaultBranchCacheForTests } from '../source-control/repo-default-branch'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

/** Serve the remote URL plus the #9171 default-branch resolver probes. */
function primeGitExecWithDefaultBranch(defaultRef = 'refs/remotes/origin/main'): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote') {
      return { stdout: 'https://dev.azure.com/acme/Project/_git/repo\n', stderr: '' }
    }
    if (args[0] === 'symbolic-ref' && args.includes('refs/remotes/origin/HEAD')) {
      return { stdout: `${defaultRef}\n`, stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args.includes(defaultRef)) {
      return { stdout: 'default-oid\n', stderr: '' }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
}

const OLD_ENV = process.env
const OLD_FETCH = globalThis.fetch

describe('Azure DevOps client', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV, ORCA_AZURE_DEVOPS_TOKEN: 'pat-token' }
    gitExecFileAsyncMock.mockReset()
    _resetAzureDevOpsRepoRefCache()
    __resetRepoDefaultBranchCacheForTests()
  })

  afterEach(() => {
    process.env = OLD_ENV
    globalThis.fetch = OLD_FETCH
    _resetAzureDevOpsRepoRefCache()
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

  it('getAzureDevOpsPullRequestForBranchOrThrow surfaces a list failure instead of null (finding 4)', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://dev.azure.com/acme/Project/_git/repo\n'
    })
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname === '/acme/Project/_apis/git/repositories/repo') {
        return new Response(
          JSON.stringify({
            id: 'repo-guid',
            webUrl: 'https://dev.azure.com/acme/Project/_git/repo'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      // The pull-request list lookup fails (auth/transport).
      return new Response(JSON.stringify({ message: 'forbidden' }), { status: 403 })
    }) as never

    // The swallowing variant collapses the failure into a false "no PR".
    await expect(
      getAzureDevOpsPullRequestForBranch('/repo', 'refs/heads/feature/azure')
    ).resolves.toBeNull()
    _resetAzureDevOpsRepoRefCache()
    // The throwing variant makes the failure visible so eligibility records
    // `unavailable` rather than a false "No pull request found".
    await expect(
      getAzureDevOpsPullRequestForBranchOrThrow('/repo', 'refs/heads/feature/azure')
    ).rejects.toThrow(/Azure DevOps request failed/)
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

  it('hides a stale completed/abandoned PR whose source branch is the repo default branch (#9171)', async () => {
    primeGitExecWithDefaultBranch()
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
              pullRequestId: 30,
              title: 'Accidental PR from main',
              status: 'abandoned',
              creationDate: '2026-05-10T00:00:00Z',
              closedDate: '2026-05-11T00:00:00Z',
              lastMergeSourceCommit: { commitId: 'stale-main-oid' }
            }
          ]
        })
      }
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
    }) as never

    await expect(getAzureDevOpsPullRequestForBranch('/repo', 'refs/heads/main')).resolves.toBeNull()
  })

  it('discards a completed default-branch shadow and refetches the linked PR (#9171)', async () => {
    primeGitExecWithDefaultBranch()
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
              pullRequestId: 32,
              title: 'Completed PR from main',
              status: 'completed',
              creationDate: '2026-05-10T00:00:00Z',
              closedDate: '2026-05-12T00:00:00Z',
              lastMergeSourceCommit: { commitId: 'shadow-oid' }
            }
          ]
        })
      }
      if (url.pathname === '/acme/Project/_apis/git/repositories/repo-guid/pullRequests/40') {
        return response({
          pullRequestId: 40,
          title: 'Linked PR',
          status: 'active',
          creationDate: '2026-05-13T00:00:00Z',
          mergeStatus: 'succeeded',
          lastMergeSourceCommit: { commitId: 'linked-oid' }
        })
      }
      if (
        url.pathname === '/acme/Project/_apis/git/repositories/repo-guid/pullRequests/40/statuses'
      ) {
        return response({ value: [{ state: 'succeeded' }] })
      }
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
    }) as never

    await expect(
      getAzureDevOpsPullRequestForBranch('/repo', 'refs/heads/main', 40)
    ).resolves.toMatchObject({ number: 40, state: 'open' })
  })

  it('keeps an active PR whose source branch is the repo default branch', async () => {
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
              pullRequestId: 31,
              title: 'main → release',
              status: 'active',
              creationDate: '2026-05-10T00:00:00Z',
              mergeStatus: 'succeeded',
              lastMergeSourceCommit: { commitId: 'main-head-oid' }
            }
          ]
        })
      }
      if (
        url.pathname === '/acme/Project/_apis/git/repositories/repo-guid/pullRequests/31/statuses'
      ) {
        return response({ value: [{ state: 'succeeded' }] })
      }
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 })
    }) as never

    await expect(
      getAzureDevOpsPullRequestForBranch('/repo', 'refs/heads/main')
    ).resolves.toMatchObject({ number: 31, state: 'open' })
  })

  it('cancels unread error-response bodies so bundled undici cannot crash on socket close', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://dev.azure.com/acme/Project/_git/repo\n'
    })
    let cancelledBodies = 0
    const fetchMock = vi.fn(async () =>
      cancelTrackingResponse(502, () => {
        cancelledBodies += 1
      })
    )
    globalThis.fetch = fetchMock as never

    await getAzureDevOpsPullRequestForBranch('/repo', 'refs/heads/feature/azure')

    expect(fetchMock).toHaveBeenCalled()
    expect(cancelledBodies).toBe(fetchMock.mock.calls.length)
  })
})
