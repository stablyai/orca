import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  getEnterpriseGitHubRepoSlugMock,
  getEnterpriseGitHubRepoSlugForRemoteMock,
  extractExecErrorMock,
  acquireMock,
  releaseMock,
  getSshFilesystemProviderMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  getEnterpriseGitHubRepoSlugMock: vi.fn(),
  getEnterpriseGitHubRepoSlugForRemoteMock: vi.fn(),
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
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock,
  getEnterpriseGitHubRepoSlugForRemote: getEnterpriseGitHubRepoSlugForRemoteMock,
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

import { createGitHubPullRequest } from './client'

import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'

// The origin-repository cache is module-level state; reset it so slugs
// resolved by one test cannot leak into the next.
beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
})

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
    getEnterpriseGitHubRepoSlugForRemoteMock.mockReset()
    getEnterpriseGitHubRepoSlugForRemoteMock.mockResolvedValue(null)
    extractExecErrorMock.mockClear()
    acquireMock.mockReset()
    releaseMock.mockReset()
    getSshFilesystemProviderMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
  })

  const mockNonForkRepository = () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ isFork: false, parent: null })
    })
  }

  it('creates a GitHub pull request with normalized refs and a body file', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    mockNonForkRepository()
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

    const [args, options] = ghExecFileAsyncMock.mock.calls[1]
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
    expect(acquireMock).toHaveBeenCalledTimes(2)
    expect(releaseMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the target and head in one repository when upstream matches origin', async () => {
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    mockNonForkRepository()
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ number: 4, url: 'https://github.com/acme/widgets/pull/4' })
    })

    await expect(
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'main',
        head: 'feature/same-repository',
        title: 'Same repository'
      })
    ).resolves.toMatchObject({ ok: true, number: 4 })

    const [args] = ghExecFileAsyncMock.mock.calls[1]
    expect(args[args.indexOf('--repo') + 1]).toBe('acme/widgets')
    expect(args[args.indexOf('--head') + 1]).toBe('feature/same-repository')
  })

  it('targets the upstream parent and qualifies the fork head on a fork checkout', async () => {
    // The target and head repositories are separate GitHub PR topology values.
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
      remoteName === 'origin'
        ? { owner: 'fsdwen', repo: 'orca' }
        : { owner: 'stablyai', repo: 'orca' }
    )
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        isFork: true,
        parent: { name: 'orca', owner: { login: 'stablyai' } }
      })
    })
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

    const [args] = ghExecFileAsyncMock.mock.calls[1]
    expect(args[args.indexOf('--repo') + 1]).toBe('stablyai/orca')
    expect(args[args.indexOf('--head') + 1]).toBe('fsdwen:my-branch')
  })

  it('uses the GitHub parent for a plain clone of a fork', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'fsdwen', repo: 'orca' })
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
      remoteName === 'origin' ? { owner: 'fsdwen', repo: 'orca' } : null
    )
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        isFork: true,
        parent: { name: 'orca', owner: { login: 'stablyai' } }
      })
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ number: 8, url: 'https://github.com/stablyai/orca/pull/8' })
    })

    await expect(
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'main',
        head: 'my-branch',
        title: 'Plain clone fork PR'
      })
    ).resolves.toMatchObject({ ok: true, number: 8 })

    const [args] = ghExecFileAsyncMock.mock.calls[1]
    expect(args[args.indexOf('--repo') + 1]).toBe('stablyai/orca')
    expect(args[args.indexOf('--head') + 1]).toBe('fsdwen:my-branch')
  })

  it('looks up an existing fork PR through the REST head filter', async () => {
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
      remoteName === 'origin'
        ? { owner: 'fsdwen', repo: 'orca' }
        : { owner: 'stablyai', repo: 'orca' }
    )
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        isFork: true,
        parent: { name: 'orca', owner: { login: 'stablyai' } }
      })
    })
    ghExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('already exists'), {
        stderr: 'a pull request for branch "my-branch" already exists'
      })
    )
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ number: 9, html_url: 'https://github.com/stablyai/orca/pull/9' }])
    })

    await expect(
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'main',
        head: 'my-branch',
        title: 'Existing fork PR'
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'already_exists',
      existingReview: { number: 9, url: 'https://github.com/stablyai/orca/pull/9' }
    })

    const [lookupArgs] = ghExecFileAsyncMock.mock.calls[2]
    expect(lookupArgs[0]).toBe('api')
    expect(lookupArgs[1]).toContain('head=fsdwen%3Amy-branch')
    expect(lookupArgs[1]).toContain('base=main')
    expect(ghExecFileAsyncMock.mock.calls[2][0]).not.toContain('pr')
  })

  it('fails closed when fork ownership cannot be verified', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'fsdwen', repo: 'orca' })
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('temporary GitHub failure'))

    await expect(
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'main',
        head: 'my-branch',
        title: 'Unverified fork PR'
      })
    ).resolves.toMatchObject({ ok: false, code: 'validation' })

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('fails closed when GitHub returns a fork without parent metadata', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'fsdwen', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ isFork: true, parent: null })
    })

    await expect(
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'main',
        head: 'my-branch',
        title: 'Malformed fork PR'
      })
    ).resolves.toMatchObject({ ok: false, code: 'validation' })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('rejects an upstream remote that disagrees with the verified parent', async () => {
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
      remoteName === 'origin'
        ? { owner: 'fsdwen', repo: 'orca' }
        : { owner: 'other-owner', repo: 'orca' }
    )
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        isFork: true,
        parent: { name: 'orca', owner: { login: 'stablyai' } }
      })
    })

    await expect(
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'main',
        head: 'my-branch',
        title: 'Mismatched upstream PR'
      })
    ).resolves.toMatchObject({ ok: false, code: 'validation' })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('recovers an existing fork PR after unknown completion', async () => {
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
      remoteName === 'origin'
        ? { owner: 'fsdwen', repo: 'orca' }
        : { owner: 'stablyai', repo: 'orca' }
    )
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        isFork: true,
        parent: { name: 'orca', owner: { login: 'stablyai' } }
      })
    })
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('request timed out'))
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ number: 10, html_url: 'https://github.com/stablyai/orca/pull/10' }])
    })

    await expect(
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'main',
        head: 'my-branch',
        title: 'Unknown completion fork PR'
      })
    ).resolves.toMatchObject({
      ok: false,
      code: 'already_exists',
      existingReview: { number: 10, url: 'https://github.com/stablyai/orca/pull/10' }
    })

    expect(ghExecFileAsyncMock.mock.calls[2][0]).toEqual([
      'api',
      expect.stringContaining('head=fsdwen%3Amy-branch')
    ])
  })

  it('falls back to the origin repository when no upstream is available', async () => {
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
      remoteName === 'origin' ? { owner: 'acme', repo: 'widgets' } : null
    )
    mockNonForkRepository()
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ number: 6, url: 'https://github.com/acme/widgets/pull/6' })
    })

    await expect(
      createGitHubPullRequest('/repo-root', {
        provider: 'github',
        base: 'main',
        head: 'feature/no-upstream',
        title: 'Origin fallback'
      })
    ).resolves.toMatchObject({ ok: true, number: 6 })

    const [args] = ghExecFileAsyncMock.mock.calls[1]
    expect(args[args.indexOf('--repo') + 1]).toBe('acme/widgets')
    expect(args[args.indexOf('--head') + 1]).toBe('feature/no-upstream')
  })

  it('routes --repo to the Enterprise server via options.host for a GHES remote (#8312)', async () => {
    // github.com-only slug parsing misses GHES, so creation comes from the
    // enterprise resolver, which carries the host.
    getOwnerRepoMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValueOnce({
      owner: 'team',
      repo: 'orca',
      host: 'github.acme-corp.com'
    })
    mockNonForkRepository()
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

    const [args, options] = ghExecFileAsyncMock.mock.calls[1]
    // The runner host-qualifies argv at spawn time from options.host, so the
    // mocked call sees a bare owner/repo plus the host in exec options.
    expect(args[args.indexOf('--repo') + 1]).toBe('team/orca')
    expect(options).toMatchObject({ host: 'github.acme-corp.com' })
  })

  it('routes the GHES existing-PR fallback lookup through options.host (#8312)', async () => {
    getOwnerRepoMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue({
      owner: 'team',
      repo: 'orca',
      host: 'github.acme-corp.com'
    })
    mockNonForkRepository()
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

    const [listArgs, listOptions] = ghExecFileAsyncMock.mock.calls[2]
    expect(listArgs).toEqual(expect.arrayContaining(['pr', 'list']))
    expect(listArgs[listArgs.indexOf('--repo') + 1]).toBe('team/orca')
    expect(listOptions).toMatchObject({ host: 'github.acme-corp.com' })
  })

  it('runs local WSL project pull request creation through the selected distro', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    mockNonForkRepository()
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

    const [, options] = ghExecFileAsyncMock.mock.calls[1]
    expect(options).toMatchObject({
      cwd: '/repo-root',
      wslDistro: 'Ubuntu',
      timeout: 60_000,
      idempotent: false
    })
  })

  it('creates SSH-backed pull requests without using the remote path as a local cwd', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    mockNonForkRepository()
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

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith(
      '/remote/repo-root',
      'origin',
      'ssh-1',
      {}
    )
    const [args, options] = ghExecFileAsyncMock.mock.calls[1]
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
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      mockNonForkRepository()
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
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    mockNonForkRepository()
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
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    mockNonForkRepository()
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

    expect(ghExecFileAsyncMock.mock.calls[2]).toEqual([
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
      // Why: dotcom slugs resolve with host:'github.com' so creation stays
      // pinned against a process-level GH_HOST.
      { cwd: '/repo-root', host: 'github.com' }
    ])
  })

  it('validates base, head, and title before invoking gh', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    mockNonForkRepository()

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
