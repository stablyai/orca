import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getProjectSlugMock,
  glabExecFileAsyncMock,
  glabHostnameArgsMock,
  glabHostEnvOptionsMock,
  glabRepoExecOptionsMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  getProjectSlugMock: vi.fn(),
  glabExecFileAsyncMock: vi.fn(),
  glabHostnameArgsMock: vi.fn((projectRef: { host: string }) => ['--hostname', projectRef.host]),
  glabHostEnvOptionsMock: vi.fn((projectRef: { host: string }, connectionId?: string | null) =>
    connectionId ? { env: { GITLAB_HOST: projectRef.host } } : {}
  ),
  glabRepoExecOptionsMock: vi.fn((repoPath: string, connectionId?: string | null) =>
    connectionId ? {} : { cwd: repoPath }
  ),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./client', () => ({
  getProjectSlug: getProjectSlugMock
}))

vi.mock('./gl-utils', () => ({
  acquire: acquireMock,
  release: releaseMock,
  glabExecFileAsync: glabExecFileAsyncMock,
  glabHostnameArgs: glabHostnameArgsMock,
  glabHostEnvOptions: glabHostEnvOptionsMock,
  glabRepoExecOptions: glabRepoExecOptionsMock
}))

import { createGitLabMergeRequest } from './merge-request-creation'

describe('createGitLabMergeRequest', () => {
  beforeEach(() => {
    getProjectSlugMock.mockReset()
    glabExecFileAsyncMock.mockReset()
    glabHostnameArgsMock.mockClear()
    glabHostEnvOptionsMock.mockClear()
    glabRepoExecOptionsMock.mockClear()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getProjectSlugMock.mockResolvedValue({ host: 'gitlab.com', path: 'acme/widgets' })
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
      createGitLabMergeRequest(
        '/repo-root',
        {
          provider: 'gitlab',
          base: 'main',
          head: 'feature/existing',
          title: 'Existing MR'
        },
        'local'
      )
    ).resolves.toEqual({
      ok: false,
      code: 'already_exists',
      error: 'A merge request already exists for this branch.',
      reason: 'existing_review',
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
