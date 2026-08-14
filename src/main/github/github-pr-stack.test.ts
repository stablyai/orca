import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPRStack } from '../../shared/github/pull-request-types'

const { ghExecFileAsyncMock, rateLimitGuardMock, noteRateLimitSpendMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  rateLimitGuardMock: vi.fn(() => ({ blocked: false })),
  noteRateLimitSpendMock: vi.fn()
}))

vi.mock('../git/runner', () => ({ ghExecFileAsync: ghExecFileAsyncMock }))
vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: rateLimitGuardMock,
  noteRepositoryRateLimitSpend: noteRateLimitSpendMock
}))

import {
  _resetGitHubPRStackCacheForTests,
  hydrateGitHubPRStack,
  mergeGitHubPRStack
} from './github-pr-stack'

const repository = { owner: 'stablyai', repo: 'orca', host: 'github.com' }
const summary: GitHubPRStack = {
  number: 51,
  position: 2,
  size: 3,
  baseRefName: 'main',
  baseSha: 'base-sha'
}

beforeEach(() => {
  vi.useRealTimers()
  ghExecFileAsyncMock.mockReset()
  rateLimitGuardMock.mockReset()
  rateLimitGuardMock.mockReturnValue({ blocked: false })
  noteRateLimitSpendMock.mockReset()
  _resetGitHubPRStackCacheForTests()
})

describe('hydrateGitHubPRStack', () => {
  it('maps and caches every entry in one GraphQL request', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              stack: {
                number: 51,
                size: 3,
                baseRefName: 'main',
                entries: {
                  nodes: [
                    {
                      position: 2,
                      pullRequest: {
                        number: 202,
                        title: 'API',
                        url: 'https://github.com/stablyai/orca/pull/202',
                        updatedAt: '2026-08-10T00:00:00Z',
                        state: 'OPEN',
                        isDraft: false,
                        headRefName: 'stack/api',
                        headRefOid: 'api-sha',
                        mergeable: 'MERGEABLE',
                        reviewDecision: 'APPROVED',
                        mergeStateStatus: 'CLEAN',
                        statusCheckRollup: { state: 'SUCCESS' }
                      }
                    },
                    {
                      position: 1,
                      pullRequest: {
                        number: 201,
                        title: 'Models',
                        url: 'https://github.com/stablyai/orca/pull/201',
                        updatedAt: '2026-08-10T00:00:00Z',
                        state: 'OPEN',
                        isDraft: false,
                        mergeable: 'UNKNOWN',
                        statusCheckRollup: { state: 'PENDING' }
                      }
                    }
                  ]
                }
              }
            }
          }
        }
      })
    })

    const first = await hydrateGitHubPRStack(repository, 202, summary, { cwd: '/repo' })
    const sibling = await hydrateGitHubPRStack(
      repository,
      201,
      { ...summary, position: 1 },
      { cwd: '/other-worktree' }
    )

    expect(first).toMatchObject({
      number: 51,
      position: 2,
      baseSha: 'base-sha',
      entries: [
        { number: 201, position: 1, checksStatus: 'pending' },
        {
          number: 202,
          position: 2,
          checksStatus: 'success',
          reviewDecision: 'APPROVED'
        }
      ]
    })
    expect(sibling.position).toBe(1)
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(noteRateLimitSpendMock).toHaveBeenCalledWith(
      repository,
      'graphql',
      1,
      expect.any(Object)
    )
  })

  it('refreshes cached stack details when the current PR changed', async () => {
    const response = (updatedAt: string, isDraft: boolean) => ({
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              stack: {
                number: 51,
                size: 3,
                baseRefName: 'main',
                entries: {
                  nodes: [
                    {
                      position: 2,
                      pullRequest: {
                        number: 202,
                        title: 'API',
                        url: 'https://github.com/stablyai/orca/pull/202',
                        updatedAt,
                        state: 'OPEN',
                        isDraft,
                        mergeable: 'MERGEABLE'
                      }
                    }
                  ]
                }
              }
            }
          }
        }
      })
    })
    ghExecFileAsyncMock
      .mockResolvedValueOnce(response('2026-08-10T00:00:00Z', true))
      .mockResolvedValueOnce(response('2026-08-10T00:01:00Z', false))

    const draft = await hydrateGitHubPRStack(
      repository,
      202,
      summary,
      { cwd: '/repo' },
      '2026-08-10T00:00:00Z'
    )
    const ready = await hydrateGitHubPRStack(
      repository,
      202,
      summary,
      { cwd: '/repo' },
      '2026-08-10T00:01:00Z'
    )

    expect(draft.entries?.[0]?.state).toBe('draft')
    expect(ready.entries?.[0]?.state).toBe('open')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the REST summary when GraphQL is unavailable', async () => {
    ghExecFileAsyncMock.mockRejectedValue(new Error('field is unavailable'))

    await expect(hydrateGitHubPRStack(repository, 202, summary, { cwd: '/repo' })).resolves.toEqual(
      summary
    )
  })

  it('isolates cached details across execution scopes', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              stack: { number: 51, size: 3, baseRefName: 'main', entries: { nodes: [] } }
            }
          }
        }
      })
    })

    await hydrateGitHubPRStack(repository, 202, summary, { cwd: '/repo' }, undefined, 'local:host')
    await hydrateGitHubPRStack(repository, 202, summary, {}, undefined, 'ssh:ssh-1')

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })
})

describe('mergeGitHubPRStack', () => {
  it('submits the expected head and polls pending merges to completion', async () => {
    vi.useFakeTimers()
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ status: 'pending', details: { uuid: 'merge-uuid' } })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ status: 'merged', details: { message: 'Merged' } })
      })

    const result = mergeGitHubPRStack({
      repository,
      prNumber: 202,
      method: 'squash',
      mergeAction: 'direct_merge',
      headSha: 'api-sha',
      ghOptions: { cwd: '/repo' }
    })
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(result).resolves.toEqual({ ok: true })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining([
        'PUT',
        'repos/stablyai/orca/pulls/202/merge-async',
        'merge_method=squash',
        'merge_action=direct_merge',
        'sha=api-sha'
      ]),
      expect.objectContaining({ cwd: '/repo', host: 'github.com' })
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', 'repos/stablyai/orca/pulls/202/merge-async/merge-uuid'],
      expect.objectContaining({ cwd: '/repo', host: 'github.com' })
    )
  })

  it('returns GitHub atomic failure details', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({
        status: 'failed',
        details: { message: 'A pull request has merge conflicts.' }
      })
    })

    await expect(
      mergeGitHubPRStack({
        repository,
        prNumber: 202,
        method: 'rebase',
        mergeAction: 'direct_merge',
        ghOptions: { cwd: '/repo' }
      })
    ).resolves.toEqual({ ok: false, error: 'A pull request has merge conflicts.' })
  })

  it('omits the unsupported merge method when queueing a stack', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({ status: 'enqueued', details: { message: 'Queued' } })
    })

    await expect(
      mergeGitHubPRStack({
        repository,
        prNumber: 202,
        method: 'squash',
        mergeAction: 'merge_queue',
        ghOptions: { cwd: '/repo' }
      })
    ).resolves.toEqual({ ok: true })

    const command = ghExecFileAsyncMock.mock.calls[0]?.[0]
    expect(command).toContain('merge_action=merge_queue')
    expect(command).not.toContain('merge_method=squash')
  })

  it('continues polling after a transient transport failure', async () => {
    vi.useFakeTimers()
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ status: 'pending', details: { uuid: 'merge-uuid' } })
      })
      .mockRejectedValueOnce(new Error('temporary gateway failure'))
      .mockResolvedValueOnce({ stdout: JSON.stringify({ status: 'merged' }) })

    const result = mergeGitHubPRStack({
      repository,
      prNumber: 202,
      method: 'squash',
      mergeAction: 'direct_merge',
      ghOptions: { cwd: '/repo' }
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(result).resolves.toEqual({ ok: true })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)
  })

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

    await expect(result).resolves.toEqual({
      ok: false,
      error: 'GitHub is still merging this stack. Refresh to check its status.'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(181)
  })
})
