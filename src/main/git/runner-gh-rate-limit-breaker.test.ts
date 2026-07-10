import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock, spawnMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock,
  spawn: spawnMock
}))

import { ghExecFileAsync } from './runner'
import { _resetGhRateLimitBreaker } from './gh-rate-limit-breaker'

const PRIMARY_RATE_LIMIT_STDERR =
  'gh: API rate limit exceeded for user ID 1775218. Please wait. (HTTP 403)'

function mockGhFailure(stderr: string): void {
  execFileMock.mockImplementation((_binary, _args, options, callback) => {
    const done = typeof options === 'function' ? options : callback
    queueMicrotask(() =>
      done(Object.assign(new Error(`Command failed: gh\n${stderr}`), { stderr }), '', stderr)
    )
    return { once: vi.fn() }
  })
}

function mockGhSuccess(stdout: string): void {
  execFileMock.mockImplementation((_binary, _args, options, callback) => {
    const done = typeof options === 'function' ? options : callback
    queueMicrotask(() => done(null, stdout, ''))
    return { once: vi.fn() }
  })
}

beforeEach(() => {
  execFileMock.mockReset()
})

afterEach(() => {
  _resetGhRateLimitBreaker()
})

describe('ghExecFileAsync rate-limit breaker', () => {
  it('spawns once for a primary 403, then short-circuits same-bucket calls', async () => {
    mockGhFailure(PRIMARY_RATE_LIMIT_STDERR)
    await expect(
      ghExecFileAsync(['api', '--cache', '120s', 'search/issues?q=repo:a/b&per_page=1'])
    ).rejects.toThrow('rate limit')
    expect(execFileMock).toHaveBeenCalledTimes(1)

    // The 90-repo storm case: every further search-bucket call must fail fast
    // without a subprocess.
    await expect(
      ghExecFileAsync(['api', '--cache', '120s', 'search/issues?q=repo:c/d&per_page=1'])
    ).rejects.toMatchObject({ ghRateLimitBlocked: true })
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })

  it('keeps other buckets working while one bucket is blocked', async () => {
    mockGhFailure(PRIMARY_RATE_LIMIT_STDERR)
    await expect(ghExecFileAsync(['api', 'search/issues?q=x'])).rejects.toThrow()
    mockGhSuccess('[]')
    await expect(ghExecFileAsync(['pr', 'list', '--limit', '36'])).resolves.toEqual({
      stdout: '[]',
      stderr: ''
    })
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('never blocks the exempt rate_limit probe', async () => {
    mockGhFailure(PRIMARY_RATE_LIMIT_STDERR)
    await expect(ghExecFileAsync(['api', 'repos/a/b/pulls'])).rejects.toThrow()
    mockGhSuccess('{"resources":{}}')
    await expect(ghExecFileAsync(['api', 'rate_limit'])).resolves.toMatchObject({
      stdout: '{"resources":{}}'
    })
    expect(execFileMock).toHaveBeenCalledTimes(2)
  })

  it('does not trip the breaker on secondary rate limits', async () => {
    mockGhFailure('gh: You have exceeded a secondary rate limit. (HTTP 403)')
    await expect(
      ghExecFileAsync(['api', 'repos/a/b/pulls'], { idempotent: false })
    ).rejects.toThrow()
    mockGhSuccess('[]')
    await expect(ghExecFileAsync(['api', 'repos/a/b/pulls'])).resolves.toEqual({
      stdout: '[]',
      stderr: ''
    })
  })
})
