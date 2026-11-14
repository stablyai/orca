import type * as GithubRepositoryIdentityModule from '../../repositories/github-repository-identity'
import type * as GitExecFileModule from '../../../git/command-runner/git-exec-file'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  getEnterpriseGitHubRepoSlugMock,
  extractExecErrorMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  getEnterpriseGitHubRepoSlugMock: vi.fn(),
  extractExecErrorMock: vi.fn((error: unknown) => {
    const value = error as { stderr?: string; stdout?: string; message?: string }
    return {
      stderr: value?.stderr ?? value?.message ?? '',
      stdout: value?.stdout ?? ''
    }
  }),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('../../execution/github-legacy-command', () => ({
  execFileAsync: vi.fn()
}))

vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('../../repositories/github-owner-repo-selection', () => ({
  getOwnerRepo: getOwnerRepoMock
}))

vi.mock('../../repositories/github-repository-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubRepositoryIdentityModule>()),
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
  githubRepoContext: vi.fn((repoPath: string, connectionId?: string | null, options = {}) => ({
    ...options,
    repoPath,
    connectionId: connectionId ?? null
  })),
  ghRepoExecOptions: vi.fn(
    (context: { repoPath: string; connectionId?: string | null; wslDistro?: string }) =>
      context.connectionId
        ? {}
        : { cwd: context.repoPath, ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}) }
  ),
  _resetOwnerRepoCache: vi.fn()
}))

vi.mock('../../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  gitExecFileAsync: vi.fn()
}))

vi.mock('../../execution/github-operation-slots', () => ({
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('../../repositories/github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock,
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

import { createGitHubPullRequest } from './create-github-pull-request'

import { _resetOriginGitHubApiRepositoryCache } from '../../repositories/github-api-repository-remote-probe'

beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
})

describe('createGitHubPullRequest', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    // Bridge explicit-origin creation to the fixtures that define getOwnerRepoMock.
    getOwnerRepoForRemoteMock.mockImplementation(
      async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
        remoteName === 'origin' ? getOwnerRepoMock(repoPath, connectionId, opts) : null
    )
    getEnterpriseGitHubRepoSlugMock.mockReset()
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)
    extractExecErrorMock.mockClear()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
  })

  it('returns the existing PR when gh reports an already-open pull request', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce({ stderr: 'a pull request already exists for feature/existing' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 44,
            url: 'https://github.com/acme/widgets/pull/44'
          }
        ])
      })

    await expect(
      createGitHubPullRequest(
        '/repo-root',
        {
          provider: 'github',
          base: 'main',
          head: 'refs/remotes/origin/feature/existing',
          title: 'Existing'
        },
        'local'
      )
    ).resolves.toEqual({
      ok: false,
      code: 'already_exists',
      error: 'A pull request already exists for this branch.',
      reason: 'existing_review',
      existingReview: {
        number: 44,
        url: 'https://github.com/acme/widgets/pull/44'
      }
    })

    expect(ghExecFileAsyncMock.mock.calls[1]).toEqual([
      [
        'pr',
        'list',
        '--repo',
        'acme/widgets',
        '--head',
        'feature/existing',
        '--base',
        'main',
        '--state',
        'open',
        '--limit',
        '2',
        '--json',
        'number,url'
      ],
      // Pin dotcom against process-level GH_HOST.
      { cwd: '/repo-root', host: 'github.com' }
    ])
  })
})
