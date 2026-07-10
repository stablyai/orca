import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  extractExecErrorMock,
  acquireMock,
  releaseMock,
  getSshFilesystemProviderMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
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
  getOwnerRepoForRemote: vi.fn(),
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

import { createGitHubPullRequest } from './client'

describe('createGitHubPullRequest', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
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

    expect(getOwnerRepoMock).toHaveBeenCalledWith('/remote/repo-root', 'ssh-1')
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
