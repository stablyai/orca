import { beforeEach, describe, expect, it, vi } from 'vitest'

const { acquireMock, ghExecFileAsyncMock, noteRepositoryRateLimitSpendMock, releaseMock } =
  vi.hoisted(() => ({
    acquireMock: vi.fn(),
    ghExecFileAsyncMock: vi.fn(),
    noteRepositoryRateLimitSpendMock: vi.fn(),
    releaseMock: vi.fn()
  }))

vi.mock('./internals', () => ({
  acquire: acquireMock,
  release: releaseMock,
  extractExecError: vi.fn(),
  ghExecFileAsync: ghExecFileAsyncMock,
  noteRepositoryRateLimitSpend: noteRepositoryRateLimitSpendMock,
  projectGhExecOptions: (host?: string) => ({ host: host ?? 'github.com' }),
  projectHostAuthenticationError: vi.fn().mockResolvedValue(null),
  repositoryRateLimitGuard: vi.fn().mockReturnValue({ blocked: false }),
  runGraphql: vi.fn(),
  validateSlugArgs: () => ({ ok: true })
}))

vi.mock('./project-error-classification', () => ({
  classifyProjectError: vi.fn(),
  rateLimitedError: vi.fn()
}))

import { listAssignableUsersBySlug, listLabelsBySlug } from './repository-field-options'

describe('repository field options', () => {
  beforeEach(() => {
    acquireMock.mockReset().mockResolvedValue(undefined)
    releaseMock.mockReset()
    noteRepositoryRateLimitSpendMock.mockReset()
    ghExecFileAsyncMock.mockReset()
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

  it('merges seed assignees after paginated provider results', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: '{"login":"octo","name":null,"avatarUrl":"octo.png"}\n',
      stderr: ''
    })

    const result = await listAssignableUsersBySlug({
      owner: 'acme',
      repo: 'widgets',
      seedLogins: ['octo', 'hubot']
    })

    expect(result).toEqual({
      ok: true,
      users: [
        { login: 'octo', name: null, avatarUrl: 'octo.png' },
        { login: 'hubot', name: null, avatarUrl: '' }
      ]
    })
  })
})
