import { beforeEach, describe, expect, it, vi } from 'vitest'

const { acquireMock, ghExecFileAsyncMock, releaseMock, runRestMock } = vi.hoisted(() => ({
  acquireMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  releaseMock: vi.fn(),
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
  classifyProjectError: (stderr: string) => ({ type: 'unknown', message: stderr }),
  rateLimitedError: () => ({ type: 'rate_limited', message: 'rate limited' }),
  runGraphql: vi.fn(),
  runRest: runRestMock,
  validateSlugArgs: (owner: string, repo: string) =>
    owner && repo ? { ok: true } : { ok: false, error: { type: 'validation_error' } },
  assertPositiveInt: (value: number, name: string) =>
    Number.isInteger(value) && value > 0
      ? { ok: true, value }
      : { ok: false, error: { type: 'validation_error', message: `${name} invalid` } }
}))

import { updateIssueBySlug } from './mutations'

describe('updateIssueBySlug', () => {
  beforeEach(() => {
    acquireMock.mockReset().mockResolvedValue(undefined)
    ghExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
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
      { encoding: 'utf-8' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['issue', 'close', '13', '--repo', 'acme/widgets', '--reason', 'not planned'],
      { encoding: 'utf-8' }
    )
    expect(runRestMock).not.toHaveBeenCalled()
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
      { encoding: 'utf-8' }
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
      { encoding: 'utf-8' }
    )
  })
})
