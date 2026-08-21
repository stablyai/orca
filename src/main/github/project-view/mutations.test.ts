import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  acquireMock,
  ghExecFileAsyncMock,
  noteRepositoryRateLimitSpendMock,
  projectHostAuthenticationErrorMock,
  repositoryRateLimitGuardMock,
  releaseMock,
  runGraphqlMock,
  runRestMock
} = vi.hoisted(() => ({
  acquireMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  noteRepositoryRateLimitSpendMock: vi.fn(),
  projectHostAuthenticationErrorMock: vi.fn(),
  repositoryRateLimitGuardMock: vi.fn(),
  releaseMock: vi.fn(),
  runGraphqlMock: vi.fn(),
  runRestMock: vi.fn()
}))

vi.mock('./internals', () => ({
  acquire: acquireMock,
  release: releaseMock,
  extractExecError: (err: unknown) => ({
    stderr: err instanceof Error ? err.message : String(err),
    stdout: ''
  }),
  ghExecFileAsync: ghExecFileAsyncMock,
  rateLimitGuard: () => ({ blocked: false }),
  noteRateLimitSpend: vi.fn(),
  repositoryRateLimitGuard: repositoryRateLimitGuardMock,
  noteRepositoryRateLimitSpend: noteRepositoryRateLimitSpendMock,
  projectHostAuthenticationError: projectHostAuthenticationErrorMock,
  projectGhExecOptions: (host?: string) => (host ? { host } : {}),
  classifyProjectError: (stderr: string) => ({ type: 'unknown', message: stderr }),
  rateLimitedError: () => ({ type: 'rate_limited', message: 'rate limited' }),
  runGraphql: runGraphqlMock,
  runRest: runRestMock,
  validateSlugArgs: (owner: string, repo: string) =>
    owner && repo ? { ok: true } : { ok: false, error: { type: 'validation_error' } },
  assertPositiveInt: (value: number, name: string) =>
    Number.isInteger(value) && value > 0
      ? { ok: true, value }
      : { ok: false, error: { type: 'validation_error', message: `${name} invalid` } }
}))

import { getWorkItemDetailsBySlug, updateIssueBySlug } from './mutations'

describe('updateIssueBySlug', () => {
  beforeEach(() => {
    acquireMock.mockReset().mockResolvedValue(undefined)
    ghExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
    noteRepositoryRateLimitSpendMock.mockReset()
    projectHostAuthenticationErrorMock.mockReset().mockResolvedValue(null)
    repositoryRateLimitGuardMock.mockReset().mockReturnValue({ blocked: false })
    releaseMock.mockReset()
    runRestMock.mockReset().mockResolvedValue({ ok: true, data: {} })
  })

  it('closes slug-addressed issues with completed and not planned reasons via gh issue close', async () => {
    await expect(
      updateIssueBySlug({
        owner: 'acme',
        repo: 'widgets',
        number: 12,
        updates: { state: 'closed', stateReason: 'completed' }
      })
    ).resolves.toEqual({ ok: true })
    await expect(
      updateIssueBySlug({
        owner: 'acme',
        repo: 'widgets',
        number: 13,
        updates: { state: 'closed', stateReason: 'not_planned' }
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['issue', 'close', '12', '--repo', 'acme/widgets', '--reason', 'completed'],
      { encoding: 'utf-8', host: 'github.com' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['issue', 'close', '13', '--repo', 'acme/widgets', '--reason', 'not planned'],
      { encoding: 'utf-8', host: 'github.com' }
    )
    expect(runRestMock).not.toHaveBeenCalled()
  })

  it('rejects an unconfigured Enterprise host before spawning gh', async () => {
    projectHostAuthenticationErrorMock.mockResolvedValue({
      type: 'auth_required',
      message: 'GitHub host is not authenticated'
    })

    await expect(
      updateIssueBySlug({
        owner: 'acme',
        repo: 'widgets',
        host: 'evil.example.test',
        number: 12,
        updates: { state: 'closed' }
      })
    ).resolves.toMatchObject({ ok: false, error: { type: 'auth_required' } })

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(runRestMock).not.toHaveBeenCalled()
  })

  it('guards and accounts state mutations in the selected host quota scope', async () => {
    const args = {
      owner: 'acme',
      repo: 'widgets',
      host: 'github.corp.example',
      number: 12,
      updates: { state: 'closed' as const }
    }

    await expect(updateIssueBySlug(args)).resolves.toEqual({ ok: true })

    expect(repositoryRateLimitGuardMock).toHaveBeenCalledWith(args, 'core')
    expect(noteRepositoryRateLimitSpendMock).toHaveBeenCalledWith(args, 'core')
  })

  it('does not spawn a state mutation while that host quota is blocked', async () => {
    repositoryRateLimitGuardMock.mockReturnValue({ blocked: true })

    await expect(
      updateIssueBySlug({
        owner: 'acme',
        repo: 'widgets',
        host: 'github.corp.example',
        number: 12,
        updates: { state: 'closed' }
      })
    ).resolves.toMatchObject({ ok: false, error: { type: 'rate_limited' } })

    expect(noteRepositoryRateLimitSpendMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('closes slug-addressed duplicate issues with --duplicate-of', async () => {
    await expect(
      updateIssueBySlug({
        owner: 'acme',
        repo: 'widgets',
        number: 12,
        updates: { state: 'closed', stateReason: 'duplicate', duplicateOf: 99 }
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['issue', 'close', '12', '--repo', 'acme/widgets', '--duplicate-of', '99'],
      { encoding: 'utf-8', host: 'github.com' }
    )
    expect(runRestMock).not.toHaveBeenCalled()
  })

  it('rejects duplicate closes without a target before spawning gh', async () => {
    const result = await updateIssueBySlug({
      owner: 'acme',
      repo: 'widgets',
      number: 12,
      updates: { state: 'closed', stateReason: 'duplicate' }
    })

    expect(result).toMatchObject({
      ok: false,
      error: { type: 'validation_error' }
    })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(runRestMock).not.toHaveBeenCalled()
  })

  it('reopens slug-addressed issues via gh issue reopen', async () => {
    await expect(
      updateIssueBySlug({
        owner: 'acme',
        repo: 'widgets',
        number: 12,
        updates: { state: 'open' }
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['issue', 'reopen', '12', '--repo', 'acme/widgets'],
      { encoding: 'utf-8', host: 'github.com' }
    )
  })

  it('threads the GHES host into gh exec and REST options', async () => {
    await expect(
      updateIssueBySlug({
        owner: 'acme',
        repo: 'widgets',
        number: 12,
        host: 'github.corp.example',
        updates: { state: 'closed', stateReason: 'completed', title: 'New title' }
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['issue', 'close', '12', '--repo', 'acme/widgets', '--reason', 'completed'],
      { encoding: 'utf-8', host: 'github.corp.example' }
    )
    expect(runRestMock).toHaveBeenCalledWith(
      ['-X', 'PATCH', 'repos/acme/widgets/issues/12', '--raw-field', 'title=New title'],
      undefined,
      'core',
      { host: 'github.corp.example' }
    )
  })
})

describe('getWorkItemDetailsBySlug', () => {
  beforeEach(() => {
    runGraphqlMock.mockReset()
  })

  it('threads the GHES host into the GraphQL exec options', async () => {
    runGraphqlMock.mockResolvedValue({
      ok: true,
      data: {
        repository: {
          issue: {
            id: 'I_1',
            number: 7,
            title: 'Enterprise issue',
            url: 'https://github.corp.example/acme/widgets/issues/7',
            state: 'OPEN'
          }
        }
      }
    })

    const result = await getWorkItemDetailsBySlug({
      owner: 'acme',
      repo: 'widgets',
      number: 7,
      type: 'issue',
      host: 'github.corp.example'
    })

    expect(result.ok).toBe(true)
    expect(runGraphqlMock).toHaveBeenCalledWith(
      expect.any(String),
      { owner: 'acme', repo: 'widgets', num: 7 },
      { host: 'github.corp.example' }
    )
  })
})
