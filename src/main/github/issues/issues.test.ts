import type * as GhExecFileModule from '../../git/command-runner/hosted-cli/gh-exec-file'
import type * as GithubOwnerRepoSelectionModule from '../repositories/github-owner-repo-selection'
import type * as GithubOperationSlotsModule from '../execution/github-operation-slots'
import type * as GithubEnterpriseRepositoryModule from '../repositories/github-enterprise-repository'
import type * as GithubApiRepositoryModule from '../repositories/github-api-repository'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('../../git/command-runner/hosted-cli/gh-exec-file', async () => {
  const actual = await vi.importActual<typeof GhExecFileModule>(
    '../../git/command-runner/hosted-cli/gh-exec-file'
  )
  return {
    ...actual,
    ghExecFileAsync: ghExecFileAsyncMock
  }
})

vi.mock('../repositories/github-owner-repo-selection', async () => {
  const actual = await vi.importActual<typeof GithubOwnerRepoSelectionModule>(
    '../repositories/github-owner-repo-selection'
  )
  return {
    ...actual,
    getOwnerRepo: getIssueOwnerRepoMock,
    resolveIssueSource: resolveIssueSourceMock
  }
})

vi.mock('../execution/github-operation-slots', async () => {
  const actual = await vi.importActual<typeof GithubOperationSlotsModule>(
    '../execution/github-operation-slots'
  )
  return {
    ...actual,
    acquire: acquireMock,
    release: releaseMock
  }
})

vi.mock('../repositories/github-enterprise-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubEnterpriseRepositoryModule>()),
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

vi.mock('../repositories/github-api-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof GithubApiRepositoryModule>()
  const withDotComHost = <T extends { host?: string } | null | undefined>(repo: T) =>
    repo ? { host: 'github.com' as const, ...repo } : repo
  return {
    ...actual,
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

import { _resetOriginGitHubApiRepositoryCache } from '../repositories/github-api-repository-remote-probe'

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

  it('keeps the accepted issue body representation through a compound metadata edit', async () => {
    const body =
      '![new](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          body,
          body_html:
            '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
        })
      })
      .mockResolvedValueOnce({ stdout: '' })
    await expect(updateIssue('/repo-root', 924, { body, title: 'Updated' })).resolves.toEqual({
      ok: true,
      bodyImageUrls: {
        'https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488':
          'https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST'
      }
    })
    expect(ghExecFileAsyncMock.mock.calls[0][0]).toContain(
      'Accept: application/vnd.github.full+json'
    )
    expect(ghExecFileAsyncMock.mock.calls[0][1].stdin).toBe(JSON.stringify({ body }))
  })

  it.each([
    '',
    'not JSON',
    JSON.stringify({
      body: 'different ![new](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)',
      body_html:
        '<img src="https://private-user-images.githubusercontent.com/1/ce11040a-fb66-4289-927f-547b16dfc488.png?jwt=TEST">'
    })
  ])(
    'keeps an accepted issue edit successful without a usable paired response (%s)',
    async (stdout) => {
      getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout })
      await expect(
        updateIssue('/repo-root', 924, {
          body: '![new](https://github.com/user-attachments/assets/ce11040a-fb66-4289-927f-547b16dfc488)'
        })
      ).resolves.toEqual({
        ok: true,
        bodyImageUrls: undefined
      })
    }
  )

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
