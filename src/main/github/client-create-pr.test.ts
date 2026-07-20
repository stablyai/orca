import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  getEnterpriseGitHubRepoSlugMock,
  extractExecErrorMock,
  acquireMock,
  releaseMock,
  getSshFilesystemProviderMock
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
  releaseMock: vi.fn(),
  getSshFilesystemProviderMock: vi.fn()
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock
}))

vi.mock('./gh-utils', () => ({
  execFileAsync: vi.fn(),
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: vi.fn(),
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
  githubRepoContext: vi.fn((repoPath: string, connectionId?: string | null) => ({
    repoPath,
    connectionId: connectionId ?? null
  })),
  ghRepoExecOptions: vi.fn((context: { repoPath: string; connectionId?: string | null }) =>
    context.connectionId ? {} : { cwd: context.repoPath }
  ),
  gitExecFileAsync: vi.fn(),
  extractExecError: extractExecErrorMock,
  parseGitHubOwnerRepo: vi.fn(),
  acquire: acquireMock,
  release: releaseMock,
  _resetOwnerRepoCache: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn()
}))

vi.mock('./github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock
}))

import { createGitHubPullRequest } from './client'

describe('createGitHubPullRequest', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    // Why: createGitHubPullRequest resolves its target via the explicit origin
    // remote (getOwnerRepo became upstream-first in #7331). Delegate the origin
    // probe to getOwnerRepoMock so existing tests keep defining it there.
    getOwnerRepoForRemoteMock.mockImplementation(
      async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
        remoteName === 'origin' ? getOwnerRepoMock(repoPath, connectionId, opts) : null
    )
    getEnterpriseGitHubRepoSlugMock.mockReset()
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)
    extractExecErrorMock.mockClear()
    acquireMock.mockReset()
    releaseMock.mockReset()
    getSshFilesystemProviderMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
  })

  it('creates a GitHub pull request with normalized refs and a body file', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        url: 'https://github.com/acme/widgets/pull/42'
      })
    })

    await expect(
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'origin/main',
        head: 'refs/heads/feature/create-pr',
        title: '  Create PR UI  ',
        body: 'Body text',
        draft: true
      })
    ).resolves.toEqual({
      ok: true,
      number: 42,
      url: 'https://github.com/acme/widgets/pull/42'
    })

    const [args, options] = ghExecFileAsyncMock.mock.calls[0]
    expect(args).toEqual(
      expect.arrayContaining([
        'pr',
        'create',
        '--repo',
        'acme/widgets',
        '--base',
        'main',
        '--head',
        'feature/create-pr',
        '--title',
        'Create PR UI',
        '--draft'
      ])
    )
    expect(args[args.indexOf('--body-file') + 1]).toMatch(/body\.md$/)
    expect(options).toMatchObject({
      cwd: '/repo-root',
      timeout: 60_000,
      idempotent: false
    })
    expect(acquireMock).toHaveBeenCalledOnce()
    expect(releaseMock).toHaveBeenCalledOnce()
  })

  it('targets the origin fork (not the upstream parent) on a fork checkout (#7331)', async () => {
    // Fork checkout: origin is the personal fork, upstream is the parent. The
    // head branch is unqualified and lives on the fork, so `gh pr create` must
    // run with --repo <fork> even though PR reads prefer upstream since #7331.
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
      remoteName === 'origin'
        ? { owner: 'fsdwen', repo: 'orca' }
        : { owner: 'stablyai', repo: 'orca' }
    )
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 5,
        url: 'https://github.com/fsdwen/orca/pull/5'
      })
    })

    await expect(
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'main',
        head: 'my-branch',
        title: 'Fork PR'
      })
    ).resolves.toEqual({
      ok: true,
      number: 5,
      url: 'https://github.com/fsdwen/orca/pull/5'
    })

    const [args] = ghExecFileAsyncMock.mock.calls[0]
    expect(args[args.indexOf('--repo') + 1]).toBe('fsdwen/orca')
    expect(args[args.indexOf('--head') + 1]).toBe('my-branch')
  })

  it('host-qualifies --repo for a GHES remote so gh targets the Enterprise server (#8312)', async () => {
    // github.com-only slug parsing misses GHES, so creation comes from the
    // enterprise resolver, which carries the host.
    getOwnerRepoMock.mockResolvedValueOnce(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValueOnce({
      owner: 'team',
      repo: 'orca',
      host: 'github.acme-corp.com'
    })
    // gh prints the PR URL (not JSON); the GHES host must still parse directly.
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://github.acme-corp.com/team/orca/pull/7\n'
    })

    await expect(
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'main',
        head: 'feature/create-pr',
        title: 'GHES PR'
      })
    ).resolves.toEqual({
      ok: true,
      number: 7,
      url: 'https://github.acme-corp.com/team/orca/pull/7'
    })

    const [args] = ghExecFileAsyncMock.mock.calls[0]
    // Bare "team/orca" would resolve against gh's default host (github.com);
    // the host prefix pins the command to the Enterprise server.
    expect(args[args.indexOf('--repo') + 1]).toBe('github.acme-corp.com/team/orca')
  })

  it('host-qualifies --repo for the GHES existing-PR fallback lookup (#8312)', async () => {
    getOwnerRepoMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue({
      owner: 'team',
      repo: 'orca',
      host: 'github.acme-corp.com'
    })
    // Create reports "already exists", forcing the pr-list fallback.
    ghExecFileAsyncMock
      .mockRejectedValueOnce(
        Object.assign(new Error('exists'), {
          stderr: 'a pull request for branch "feature/create-pr" already exists',
          stdout: ''
        })
      )
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          { number: 9, url: 'https://github.acme-corp.com/team/orca/pull/9' }
        ])
      })

    await expect(
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'main',
        head: 'feature/create-pr',
        title: 'GHES PR'
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'already_exists',
      existingReview: { number: 9, url: 'https://github.acme-corp.com/team/orca/pull/9' }
    })

    const [listArgs] = ghExecFileAsyncMock.mock.calls[1]
    expect(listArgs).toEqual(expect.arrayContaining(['pr', 'list']))
    expect(listArgs[listArgs.indexOf('--repo') + 1]).toBe('github.acme-corp.com/team/orca')
  })

  it('runs local WSL project pull request creation through the selected distro', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 43,
        url: 'https://github.com/acme/widgets/pull/43'
      })
    })

    await expect(
      createGitHubPullRequest(
        '/repo-root',
        {
          provider: 'github',
          base: 'main',
          head: 'feature/wsl-create-pr',
          title: 'WSL Create PR'
        },
        null,
        { localGitExecOptions: { wslDistro: 'Ubuntu' } }
      )
    ).resolves.toEqual({
      ok: true,
      number: 43,
      url: 'https://github.com/acme/widgets/pull/43'
    })

    const [, options] = ghExecFileAsyncMock.mock.calls[0]
    expect(options).toMatchObject({
      cwd: '/repo-root',
      wslDistro: 'Ubuntu',
      timeout: 60_000,
      idempotent: false
    })
  })

  it('creates SSH-backed pull requests without using the remote path as a local cwd', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 45,
        url: 'https://github.com/acme/widgets/pull/45'
      })
    })

    await expect(
      createGitHubPullRequest(
        '/remote/repo-root',
        {
          provider: 'github',
          base: 'main',
          head: 'feature/ssh-create-pr',
          title: 'SSH Create PR'
        },
        'ssh-1'
      )
    ).resolves.toEqual({
      ok: true,
      number: 45,
      url: 'https://github.com/acme/widgets/pull/45'
    })

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/remote/repo-root', 'origin', 'ssh-1')
    const [args, options] = ghExecFileAsyncMock.mock.calls[0]
    expect(args).toEqual(
      expect.arrayContaining([
        'pr',
        'create',
        '--repo',
        'acme/widgets',
        '--base',
        'main',
        '--head',
        'feature/ssh-create-pr'
      ])
    )
    expect(options).toMatchObject({
      timeout: 60_000,
      idempotent: false
    })
    expect(options).not.toHaveProperty('cwd')
  })

  it.each([
    ['.github/pull_request_template.md', ['.github/pull_request_template.md']],
    [
      '.github/PULL_REQUEST_TEMPLATE.md',
      ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md']
    ],
    [
      'docs/PULL_REQUEST_TEMPLATE.md',
      [
        '.github/pull_request_template.md',
        '.github/PULL_REQUEST_TEMPLATE.md',
        'pull_request_template.md',
        'PULL_REQUEST_TEMPLATE.md',
        'docs/pull_request_template.md',
        'docs/PULL_REQUEST_TEMPLATE.md'
      ]
    ]
  ] as [string, string[]][])(
    'reads PR templates from the SSH filesystem provider at %s',
    async (relativeTemplatePath, expectedRelativeLookups) => {
      const templateBody = `Remote template body from ${relativeTemplatePath}`
      const readRemoteFile = vi.fn(async (path: string) => {
        if (path === `/remote/repo-root/${relativeTemplatePath}`) {
          return {
            content: templateBody,
            isBinary: false
          }
        }
        throw new Error('missing template')
      })
      getSshFilesystemProviderMock.mockReturnValue({ readFile: readRemoteFile })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
      const writtenBodies: string[] = []
      ghExecFileAsyncMock.mockImplementationOnce(async (args: string[]) => {
        const bodyPath = args[args.indexOf('--body-file') + 1]
        writtenBodies.push(await readFile(bodyPath, 'utf8'))
        return {
          stdout: JSON.stringify({
            number: 46,
            url: 'https://github.com/acme/widgets/pull/46'
          })
        }
      })

      await expect(
        createGitHubPullRequest(
          '/remote/repo-root',
          {
            provider: 'github',
            base: 'main',
            head: 'feature/ssh-template',
            title: 'SSH Template PR',
            body: '',
            useTemplate: true
          },
          'ssh-1'
        )
      ).resolves.toEqual({
        ok: true,
        number: 46,
        url: 'https://github.com/acme/widgets/pull/46'
      })

      expect(readRemoteFile.mock.calls.map(([path]) => path)).toEqual(
        expectedRelativeLookups.map((relativeLookup) => `/remote/repo-root/${relativeLookup}`)
      )
      expect(writtenBodies).toEqual([templateBody])
    }
  )

  it('falls back to parsing the PR URL for older gh output', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://github.com/acme/widgets/pull/43\n'
    })

    await expect(
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'main',
        head: 'feature/url-output',
        title: 'URL output'
      })
    ).resolves.toEqual({
      ok: true,
      number: 43,
      url: 'https://github.com/acme/widgets/pull/43'
    })
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
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'main',
        head: 'refs/remotes/origin/feature/existing',
        title: 'Existing'
      })
    ).resolves.toEqual({
      ok: false,
      code: 'already_exists',
      error: 'A pull request already exists for this branch.',
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
      { cwd: '/repo-root' }
    ])
  })

  it('validates base, head, and title before invoking gh', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })

    await expect(
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'refs/heads/feature',
        head: 'feature',
        title: 'Feature'
      })
    ).resolves.toEqual({
      ok: false,
      code: 'validation',
      error: 'Create PR failed: choose a different base branch before creating a pull request.'
    })

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(acquireMock).not.toHaveBeenCalled()
  })
})
