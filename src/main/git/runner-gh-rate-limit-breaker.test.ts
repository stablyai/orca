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

import { fakeSpawnReturning } from '../../shared/__fixtures__/fake-spawned-child'
import { ghExecFileAsync } from './runner'
import { _resetGhRateLimitBreaker, getGhRateLimitBlockedUntilMs } from './gh-rate-limit-breaker'

const PRIMARY_RATE_LIMIT_STDERR =
  'gh: API rate limit exceeded for user ID 1775218. Please wait. (HTTP 403)'

function mockGhFailure(stderr: string): void {
  spawnMock.mockImplementation(fakeSpawnReturning({ stderr, code: 1 }))
}

function mockGhSuccess(stdout: string): void {
  spawnMock.mockImplementation(fakeSpawnReturning({ stdout }))
}

beforeEach(() => {
  execFileMock.mockReset()
  spawnMock.mockReset()
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
    expect(spawnMock).toHaveBeenCalledTimes(1)

    await expect(
      ghExecFileAsync(['api', '--cache', '120s', 'search/issues?q=repo:c/d&per_page=1'])
    ).rejects.toMatchObject({ ghRateLimitBlocked: true })
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('keeps other GitHub hosts and WSL runtimes working when github.com is blocked', async () => {
    mockGhFailure(PRIMARY_RATE_LIMIT_STDERR)
    await expect(ghExecFileAsync(['api', 'repos/a/b/pulls'])).rejects.toThrow()

    // Route this request to an independent Enterprise host.
    mockGhSuccess('[]')
    await expect(
      ghExecFileAsync(['api', 'repos/a/b/pulls'], { host: 'github.acme-corp.com' })
    ).resolves.toMatchObject({ stdout: '[]' })
    await expect(
      ghExecFileAsync(['pr', 'list', '--repo', 'a/b'], { host: 'github.acme-corp.com' })
    ).resolves.toMatchObject({ stdout: '[]' })
    await expect(
      ghExecFileAsync(['api', 'repos/a/b/pulls'], {
        env: { ...process.env, GH_HOST: 'github.acme-corp.com' }
      })
    ).resolves.toMatchObject({ stdout: '[]' })
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      await expect(
        ghExecFileAsync(['api', 'repos/a/b/pulls'], { wslDistro: 'Ubuntu' })
      ).resolves.toMatchObject({ stdout: '[]' })
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
    expect(spawnMock).toHaveBeenCalledTimes(5)
  })

  it('trips the graphql bucket on a GraphQL rate limit and leaves REST calls running', async () => {
    mockGhFailure('GraphQL: API rate limit already exceeded for user ID 1775218.')
    await expect(
      ghExecFileAsync(['pr', 'view', '12', '--repo', 'a/b', '--json', 'number'])
    ).rejects.toThrow('rate limit')
    expect(getGhRateLimitBlockedUntilMs('graphql')).not.toBeNull()
    expect(getGhRateLimitBlockedUntilMs('core')).toBeNull()

    await expect(
      ghExecFileAsync(['issue', 'close', '5', '--repo', 'a/b'], { idempotent: false })
    ).rejects.toMatchObject({ ghRateLimitBlocked: true })
    expect(spawnMock).toHaveBeenCalledTimes(1)

    mockGhSuccess('[]')
    await expect(ghExecFileAsync(['api', 'repos/a/b/pulls'])).resolves.toMatchObject({
      stdout: '[]'
    })
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })

  it('never blocks the exempt rate_limit probe', async () => {
    mockGhFailure(PRIMARY_RATE_LIMIT_STDERR)
    await expect(ghExecFileAsync(['api', 'repos/a/b/pulls'])).rejects.toThrow()
    mockGhSuccess('{"resources":{}}')
    await expect(
      ghExecFileAsync(['api', '--hostname', 'github.com', 'rate_limit'])
    ).resolves.toMatchObject({
      stdout: '{"resources":{}}'
    })
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
})
