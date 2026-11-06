import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, rateLimitGuardMock, noteRateLimitSpendMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  rateLimitGuardMock: vi.fn(() => ({ blocked: false })),
  noteRateLimitSpendMock: vi.fn()
}))

vi.mock('../git/command-runner/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: ghExecFileAsyncMock
}))
vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: rateLimitGuardMock,
  noteRepositoryRateLimitSpend: noteRateLimitSpendMock
}))
import { _resetGitHubPRStackCacheForTests, mergeGitHubPRStack } from './github-pr-stack'

const repository = { owner: 'stablyai', repo: 'orca', host: 'github.com' }

beforeEach(() => {
  vi.useRealTimers()
  ghExecFileAsyncMock.mockReset()
  rateLimitGuardMock.mockReset()
  rateLimitGuardMock.mockReturnValue({ blocked: false })
  noteRateLimitSpendMock.mockReset()
  _resetGitHubPRStackCacheForTests()
})

describe('mergeGitHubPRStack', () => {
  it('reports an in-progress merge after polling is exhausted', async () => {
    vi.useFakeTimers()
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({ status: 'pending', details: { uuid: 'merge-uuid' } })
    })

    const result = mergeGitHubPRStack({
      repository,
      prNumber: 202,
      method: 'squash',
      mergeAction: 'direct_merge',
      ghOptions: { cwd: '/repo' }
    })
    await vi.advanceTimersByTimeAsync(180_000)

    await expect(result).resolves.toMatchObject({
      ok: false,
      error: 'GitHub is still merging this stack. Refresh to check its status.'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(181)
  })
})
