import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GithubEnterpriseRepositoryModule from './github-enterprise-repository'
import type * as GhUtils from './gh-utils'

const {
  ghExecFileAsyncMock,
  getIssueOwnerRepoMock,
  resolveIssueSourceMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', async () => {
  const actual = await vi.importActual<typeof GhUtils>('./gh-utils')
  return {
    ...actual,
    ghExecFileAsync: ghExecFileAsyncMock,
    getIssueOwnerRepo: getIssueOwnerRepoMock,
    resolveIssueSource: resolveIssueSourceMock,
    acquire: acquireMock,
    release: releaseMock
  }
})

vi.mock('./github-enterprise-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubEnterpriseRepositoryModule>()),
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

vi.mock('./github-api-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof GithubApiRepositoryModule>()
  const withDotComHost = <T extends { host?: string } | null | undefined>(repo: T) =>
    repo ? { host: 'github.com' as const, ...repo } : repo
  return {
    ...actual,
    // Bridge hosted source resolution to the suite fixtures and retain explicit github.com host pinning.
    getIssueGitHubApiRepository: async (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => withDotComHost(await getIssueOwnerRepoMock(repoPath, connectionId, localGitOptions)),
    resolveIssueGitHubApiRepositorySource: async (
      repoPath: string,
      preference: unknown,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => {
      const result = await resolveIssueSourceMock(
        repoPath,
        preference,
        connectionId,
        localGitOptions
      )
      return {
        ...result,
        source: withDotComHost(result?.source)
      }
    }
  }
})
import { createIssue } from './issue-create'
import { updateIssue } from './issue-update'

import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'

beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
})

describe('issue source operations', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    resolveIssueSourceMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    // Share the preference-aware resolver with the issue-owner fixtures.
    resolveIssueSourceMock.mockImplementation(async () => ({
      source: await getIssueOwnerRepoMock(),
      fellBack: false
    }))
  })

  it('recovers issue 7704 oversized inline-image creation', async () => {
    const imagePrefix = 'data:image/png;base64,'
    const body = imagePrefix + 'x'.repeat(133596 - imagePrefix.length)
    expect(body).toContain('data:image')
    expect(body).toHaveLength(133596)

    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 422: body is too long (maximum is 65536 characters)'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 926,
          html_url: 'https://github.com/stablyai/orca/issues/926'
        })
      })
      .mockResolvedValueOnce({ stdout: '' })

    await expect(
      createIssue('/repo-root', 'Image issue', body, undefined, undefined, {
        labels: ['bug'],
        assignees: ['octo']
      })
    ).resolves.toEqual({
      ok: true,
      number: 926,
      url: 'https://github.com/stablyai/orca/issues/926'
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', '-X', 'POST', 'repos/stablyai/orca/issues', '--input', '-'],
      {
        cwd: '/repo-root',
        host: 'github.com',
        stdin: JSON.stringify({
          title: 'Image issue',
          body,
          labels: ['bug'],
          assignees: ['octo']
        })
      }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', '-X', 'POST', 'repos/stablyai/orca/issues', '--input', '-'],
      {
        cwd: '/repo-root',
        host: 'github.com',
        stdin: JSON.stringify({
          title: 'Image issue',
          body: '',
          labels: ['bug'],
          assignees: ['octo']
        })
      }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['api', '-X', 'PATCH', 'repos/stablyai/orca/issues/926', '--input', '-'],
      { cwd: '/repo-root', host: 'github.com', stdin: JSON.stringify({ body }) }
    )
  })

  it('does not retry unrelated create failures', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 422: assignees is invalid'))

    await expect(createIssue('/repo-root', 'Invalid issue', 'Body')).resolves.toEqual({
      ok: false,
      error: 'HTTP 422: assignees is invalid'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('stops when placeholder create fails during oversized-body recovery', async () => {
    const body = `data:image/png;base64,${'x'.repeat(100)}`
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('body is too long (maximum is 65536 characters)'))
      .mockRejectedValueOnce(new Error('HTTP 500: create failed'))

    await expect(createIssue('/repo-root', 'Placeholder failure', body)).resolves.toEqual({
      ok: false,
      error: 'HTTP 500: create failed'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('reports partial success when oversized-body patch fails', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('body is too long (maximum is 65536 characters)'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 928,
          html_url: 'https://github.com/stablyai/orca/issues/928'
        })
      })
      .mockRejectedValueOnce(new Error('HTTP 500: update failed'))

    await expect(createIssue('/repo-root', 'Partial issue', 'data:image')).resolves.toEqual({
      ok: true,
      number: 928,
      url: 'https://github.com/stablyai/orca/issues/928',
      bodySaveWarning:
        'Issue https://github.com/stablyai/orca/issues/928 was created, but saving its body failed: HTTP 500: update failed'
    })
  })

  it('sends large issue bodies over stdin through the REST issue endpoint', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })
    const body = `Screenshot:\ndata:image/png;base64,${'A'.repeat(40_000)}`

    await expect(updateIssue('/repo-root', 924, { body })).resolves.toEqual({
      ok: true
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', '-X', 'PATCH', 'repos/stablyai/orca/issues/924', '--input', '-'],
      { cwd: '/repo-root', host: 'github.com', stdin: JSON.stringify({ body }) }
    )
  })

  it('reports a failed close whose gh error mentions "already"', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockRejectedValueOnce(
      new Error('GraphQL: API rate limit already exceeded for user ID 1.')
    )

    await expect(updateIssue('/repo-root', 924, { state: 'closed' })).resolves.toMatchObject({
      ok: false,
      error: 'GitHub rate limit hit. Try again in a few minutes.'
    })
  })
})
