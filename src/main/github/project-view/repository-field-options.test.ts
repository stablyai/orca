import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  acquireMock,
  classifyProjectErrorMock,
  ghExecFileAsyncMock,
  noteRepositoryRateLimitSpendMock,
  releaseMock
} = vi.hoisted(() => ({
  acquireMock: vi.fn(),
  classifyProjectErrorMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  noteRepositoryRateLimitSpendMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./internals', () => ({
  acquire: acquireMock,
  release: releaseMock,
  extractExecError: vi.fn().mockReturnValue({ stderr: '', stdout: '' }),
  ghExecFileAsync: ghExecFileAsyncMock,
  noteRepositoryRateLimitSpend: noteRepositoryRateLimitSpendMock,
  projectGhExecOptions: (host?: string) => ({ host: host ?? 'github.com' }),
  projectHostAuthenticationError: vi.fn().mockResolvedValue(null),
  repositoryRateLimitGuard: vi.fn().mockReturnValue({ blocked: false }),
  runGraphql: vi.fn(),
  validateSlugArgs: () => ({ ok: true })
}))

vi.mock('./project-error-classification', () => ({
  classifyProjectError: classifyProjectErrorMock,
  rateLimitedError: vi.fn()
}))

import { listLabelsBySlug, listReviewTeamsBySlug } from './repository-field-options'

describe('repository field options', () => {
  beforeEach(() => {
    acquireMock.mockReset().mockResolvedValue(undefined)
    releaseMock.mockReset()
    noteRepositoryRateLimitSpendMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    classifyProjectErrorMock.mockReset()
  })

  it('keeps label discovery paginated and host-scoped', async () => {
    ghExecFileAsyncMock.mockResolvedValue({ stdout: 'bug\nenhancement\n', stderr: '' })

    await expect(
      listLabelsBySlug({ owner: 'acme', repo: 'widgets', host: 'github.corp.example' })
    ).resolves.toEqual({ ok: true, labels: ['bug', 'enhancement'] })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', '--paginate', 'repos/acme/widgets/labels', '--jq', '.[].name'],
      { encoding: 'utf-8', host: 'github.corp.example' }
    )
    expect(releaseMock).toHaveBeenCalledOnce()
  })

  it('lists repository teams as org-qualified reviewer logins', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: '{"slug":"core-reviewers","name":"Core Reviewers"}\n{"name":"No slug"}\n',
      stderr: ''
    })

    await expect(listReviewTeamsBySlug({ owner: 'acme', repo: 'widgets' })).resolves.toEqual({
      ok: true,
      teams: [{ login: 'acme/core-reviewers', name: 'Core Reviewers', avatarUrl: '' }]
    })
    expect(ghExecFileAsyncMock.mock.calls[0][0]).toContain('repos/acme/widgets/teams')
  })

  it('treats an inaccessible team list as no teams', async () => {
    ghExecFileAsyncMock.mockRejectedValue(new Error('HTTP 404'))
    classifyProjectErrorMock.mockReturnValue({ type: 'not_found', message: 'Not found' })

    await expect(listReviewTeamsBySlug({ owner: 'someone', repo: 'personal' })).resolves.toEqual({
      ok: true,
      teams: []
    })
    expect(releaseMock).toHaveBeenCalledOnce()
  })
})
