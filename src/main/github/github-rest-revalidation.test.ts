import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { revalidateGitHubRestJson } from './github-rest-revalidation'

const { gh, spend } = vi.hoisted(() => ({ gh: vi.fn(), spend: vi.fn() }))
vi.mock('./gh-utils', () => ({ ghExecFileAsync: gh }))
vi.mock('./rate-limit', () => ({ noteRepositoryRateLimitSpend: spend }))

const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const endpoint = 'repos/acme/widgets/pulls/7'
const options = { cwd: '/repo' }
let read: typeof revalidateGitHubRestJson
function http(status: number, body = '', etag?: string): { stdout: string; stderr: string } {
  return {
    stdout: `HTTP/2.0 ${status} ${status === 304 ? 'Not Modified' : 'OK'}\n${etag ? `Etag: ${etag}\r\n` : ''}\r\n${body}`,
    stderr: ''
  }
}
function notModified() {
  return Object.assign(new Error('gh: HTTP 304'), http(304))
}

describe('GitHub REST revalidation', () => {
  beforeEach(async () => {
    vi.resetModules()
    gh.mockReset()
    spend.mockReset()
    read = (await import('./github-rest-revalidation')).revalidateGitHubRestJson
  })
  afterEach(() => vi.unstubAllEnvs())

  it('revalidates immediately and returns the validated body on gh HTTP 304 exits without spending quota', async () => {
    gh.mockResolvedValueOnce(http(200, '{"number":7}', 'W/"v1"')).mockRejectedValueOnce(
      notModified()
    )
    expect(await read(repository, endpoint, options)).toBe('{"number":7}')
    expect(await read(repository, endpoint, options)).toBe('{"number":7}')
    expect(gh.mock.calls[1][0]).toEqual([
      'api',
      endpoint,
      '--include',
      '-H',
      'If-None-Match: W/"v1"'
    ])
    expect(spend).toHaveBeenCalledTimes(1)
    expect(spend).toHaveBeenCalledWith(repository, 'core', 1, expect.objectContaining(options))
  })

  it('replaces the validator when GitHub returns changed data', async () => {
    gh.mockResolvedValueOnce(http(200, '{"number":7}', '"v1"'))
      .mockResolvedValueOnce(http(200, '{"number":8}', '"v2"'))
      .mockRejectedValueOnce(notModified())
    await read(repository, endpoint, options)
    expect(await read(repository, endpoint, options)).toBe('{"number":8}')
    expect(await read(repository, endpoint, options)).toBe('{"number":8}')
    expect(gh.mock.calls[2][0]).toContain('If-None-Match: "v2"')
    expect(spend).toHaveBeenCalledTimes(2)
  })

  it('does not return cached data after authorization failures and discards its validator', async () => {
    gh.mockResolvedValueOnce(http(200, '{"number":7}', '"v1"'))
    await read(repository, endpoint, options)
    const failure = Object.assign(
      new Error('HTTP 403 forbidden'),
      http(403, '{"message":"forbidden"}')
    )
    gh.mockRejectedValueOnce(failure).mockResolvedValueOnce(http(200, '{"number":8}'))
    await expect(read(repository, endpoint, options)).rejects.toBe(failure)
    expect(await read(repository, endpoint, options)).toBe('{"number":8}')
    expect(gh.mock.calls[2][0]).not.toContain('-H')
  })

  it('keeps credentials, hosts, runtimes, directories, and endpoints separate', async () => {
    gh.mockResolvedValue(http(200, '{"number":7}', '"v1"'))
    await read(repository, endpoint, options)
    await read(repository, `${endpoint}/files`, options)
    await read(repository, endpoint, { cwd: '/other' })
    await read(repository, endpoint, { ...options, wslDistro: 'Ubuntu' })
    await read({ ...repository, host: 'github.example.com' }, endpoint, options)
    await read(repository, endpoint, {
      ...options,
      ghAccount: { host: 'github.com', user: 'other' }
    })
    vi.stubEnv('GH_TOKEN', 'different-test-account')
    await read(repository, endpoint, options)
    expect(gh.mock.calls.every(([args]) => !args.includes('-H'))).toBe(true)
    expect(gh.mock.calls[4][1].host).toBe('github.example.com')
  })

  it('does not retain malformed or validator-free bodies and rejects ungrounded 304 responses', async () => {
    gh.mockResolvedValueOnce(http(200, '{"number":7}'))
      .mockResolvedValueOnce(http(200, 'truncated', '"bad"'))
      .mockRejectedValueOnce(notModified())
    await read(repository, endpoint, options)
    await expect(read(repository, endpoint, options)).rejects.toThrow()
    await expect(read(repository, endpoint, options)).rejects.toThrow(
      'without a cached representation'
    )
    expect(gh.mock.calls.every(([args]) => !args.includes('-H'))).toBe(true)
  })

  it('does not let an older read replace a newer validator', async () => {
    let finish: (result: ReturnType<typeof http>) => void = () => {}
    gh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
      .mockResolvedValueOnce(http(200, '{"number":8}', '"new"'))
      .mockRejectedValueOnce(notModified())
    const older = read(repository, endpoint, options)
    await read(repository, endpoint, options)
    finish(http(200, '{"number":7}', '"old"'))
    await older
    expect(await read(repository, endpoint, options)).toBe('{"number":8}')
    expect(gh.mock.calls[2][0]).toContain('If-None-Match: "new"')
  })
})
