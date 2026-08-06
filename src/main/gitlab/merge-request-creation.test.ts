import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getProjectSlugMock,
  glabExecFileAsyncMock,
  glabHostnameArgsMock,
  glabRepoExecOptionsMock,
  acquireMock,
  releaseMock,
  getSshFilesystemProviderMock
} = vi.hoisted(() => ({
  getProjectSlugMock: vi.fn(),
  glabExecFileAsyncMock: vi.fn(),
  glabHostnameArgsMock: vi.fn((projectRef: { host: string }) => ['--hostname', projectRef.host]),
  glabRepoExecOptionsMock: vi.fn((repoPath: string, connectionId?: string | null) =>
    connectionId ? {} : { cwd: repoPath }
  ),
  acquireMock: vi.fn(),
  releaseMock: vi.fn(),
  getSshFilesystemProviderMock: vi.fn()
}))

vi.mock('./client', () => ({
  getProjectSlug: getProjectSlugMock
}))

vi.mock('./gl-utils', () => ({
  acquire: acquireMock,
  release: releaseMock,
  glabExecFileAsync: glabExecFileAsyncMock,
  glabHostnameArgs: glabHostnameArgsMock,
  glabRepoExecOptions: glabRepoExecOptionsMock
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock
}))

import { createGitLabMergeRequest } from './merge-request-creation'

describe('createGitLabMergeRequest', () => {
  beforeEach(() => {
    getProjectSlugMock.mockReset()
    glabExecFileAsyncMock.mockReset()
    glabHostnameArgsMock.mockClear()
    glabRepoExecOptionsMock.mockClear()
    acquireMock.mockReset()
    releaseMock.mockReset()
    getSshFilesystemProviderMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getProjectSlugMock.mockResolvedValue({ host: 'gitlab.com', path: 'acme/widgets' })
  })

  it('creates a GitLab merge request with normalized refs', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://gitlab.com/acme/widgets/-/merge_requests/42\n',
      stderr: ''
    })

    await expect(
      createGitLabMergeRequest('/repo-root', {
        provider: 'gitlab',
        base: 'origin/main',
        head: 'refs/heads/feature/create-mr',
        title: '  Create MR UI  ',
        body: 'Body text',
        draft: true
      })
    ).resolves.toEqual({
      ok: true,
      number: 42,
      url: 'https://gitlab.com/acme/widgets/-/merge_requests/42'
    })

    const [args, options] = glabExecFileAsyncMock.mock.calls[0]
    expect(args).toEqual(
      expect.arrayContaining([
        'mr',
        'create',
        '-R',
        'acme/widgets',
        '--target-branch',
        'main',
        '--source-branch',
        'feature/create-mr',
        '--title',
        'Create MR UI',
        '--description',
        'Body text',
        '--draft'
      ])
    )
    expect(args).toEqual(expect.arrayContaining(['--hostname', 'gitlab.com']))
    expect(options).toMatchObject({
      cwd: '/repo-root',
      timeout: 60_000,
      idempotent: false
    })
    expect(acquireMock).toHaveBeenCalledOnce()
    expect(releaseMock).toHaveBeenCalledOnce()
  })

  it('runs local WSL project merge request creation through the selected distro', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://gitlab.com/acme/widgets/-/merge_requests/43\n',
      stderr: ''
    })

    await expect(
      createGitLabMergeRequest(
        '/repo-root',
        {
          provider: 'gitlab',
          base: 'main',
          head: 'feature/wsl-create-mr',
          title: 'WSL Create MR'
        },
        null,
        { localGitExecOptions: { wslDistro: 'Ubuntu' } }
      )
    ).resolves.toEqual({
      ok: true,
      number: 43,
      url: 'https://gitlab.com/acme/widgets/-/merge_requests/43'
    })

    const [, options] = glabExecFileAsyncMock.mock.calls[0]
    expect(options).toMatchObject({
      cwd: '/repo-root',
      wslDistro: 'Ubuntu',
      timeout: 60_000,
      idempotent: false
    })
  })

  it('creates SSH-backed merge requests without using the remote path as a local cwd', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        iid: 45,
        web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/45'
      }),
      stderr: ''
    })

    await expect(
      createGitLabMergeRequest(
        '/remote/repo-root',
        {
          provider: 'gitlab',
          base: 'main',
          head: 'feature/ssh-create-mr',
          title: 'SSH Create MR'
        },
        'ssh-1'
      )
    ).resolves.toEqual({
      ok: true,
      number: 45,
      url: 'https://gitlab.com/acme/widgets/-/merge_requests/45'
    })

    expect(getProjectSlugMock).toHaveBeenCalledWith('/remote/repo-root', 'ssh-1')
    const [args, options] = glabExecFileAsyncMock.mock.calls[0]
    expect(args).toEqual(
      expect.arrayContaining([
        'mr',
        'create',
        '-R',
        'acme/widgets',
        '--target-branch',
        'main',
        '--source-branch',
        'feature/ssh-create-mr'
      ])
    )
    expect(options).toMatchObject({
      timeout: 60_000,
      idempotent: false
    })
    expect(options).not.toHaveProperty('cwd')
  })

  it('reads merge request templates from the SSH filesystem provider', async () => {
    const readRemoteFile = vi.fn(async (path: string) => {
      if (path === '/remote/repo-root/.gitlab/merge_request_templates/Default.md') {
        return { content: 'Remote MR template body', isBinary: false }
      }
      throw new Error('missing template')
    })
    getSshFilesystemProviderMock.mockReturnValue({ readFile: readRemoteFile })
    glabExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'https://gitlab.com/acme/widgets/-/merge_requests/46\n',
      stderr: ''
    })

    await expect(
      createGitLabMergeRequest(
        '/remote/repo-root',
        {
          provider: 'gitlab',
          base: 'main',
          head: 'feature/ssh-template',
          title: 'SSH Template MR',
          body: '',
          useTemplate: true
        },
        'ssh-1'
      )
    ).resolves.toEqual({
      ok: true,
      number: 46,
      url: 'https://gitlab.com/acme/widgets/-/merge_requests/46'
    })

    const [args] = glabExecFileAsyncMock.mock.calls[0]
    expect(readRemoteFile).toHaveBeenCalledWith(
      '/remote/repo-root/.gitlab/merge_request_templates/Default.md'
    )
    expect(args[args.indexOf('--description') + 1]).toBe('Remote MR template body')
  })

  it('returns an existing merge request when GitLab reports a duplicate', async () => {
    glabExecFileAsyncMock
      .mockRejectedValueOnce(new Error('merge request already exists'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            iid: 77,
            web_url: 'https://gitlab.com/acme/widgets/-/merge_requests/77'
          }
        ]),
        stderr: ''
      })

    await expect(
      createGitLabMergeRequest('/repo-root', {
        provider: 'gitlab',
        base: 'main',
        head: 'feature/existing',
        title: 'Existing MR'
      })
    ).resolves.toEqual({
      ok: false,
      code: 'already_exists',
      error: 'A merge request already exists for this branch.',
      existingReview: {
        number: 77,
        url: 'https://gitlab.com/acme/widgets/-/merge_requests/77'
      }
    })

    expect(glabExecFileAsyncMock.mock.calls[1][0]).toEqual(
      expect.arrayContaining([
        'mr',
        'list',
        '--source-branch',
        'feature/existing',
        '--target-branch',
        'main'
      ])
    )
  })
})
