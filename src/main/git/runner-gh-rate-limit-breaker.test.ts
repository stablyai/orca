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
import { ghExecFileAsync } from './command-runner/hosted-cli/gh-exec-file'
import { _resetGhRateLimitBreaker } from './gh-rate-limit-breaker'

const PRIMARY_RATE_LIMIT_STDERR =
  'gh: API rate limit exceeded for user ID 1775218. Please wait. (HTTP 403)'

function mockGhFailure(stderr: string): void {
  spawnMock.mockImplementation(fakeSpawnReturning({ stderr, code: 1 }))
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
})
