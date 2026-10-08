import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as gh from '../../gh-utils'
import * as execution from '../../github-api-repository'
import * as rateLimit from '../../rate-limit'
import { withActionsRead } from './actions-read-request'
import {
  GITHUB_CHECK_DETAILS_HOST_TIMEOUT_MS,
  GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE
} from '../../../../shared/github/check-details-deadline'
import {
  ACTIONS_ARTIFACT_HOST_TIMEOUT_MS,
  ACTIONS_ARTIFACT_TIMEOUT_MESSAGE
} from '../../../../shared/github/actions-artifact-types'

const repository = { owner: 'acme', repo: 'widgets', host: 'github.enterprise.test' }
let caller: AbortController

beforeEach(async () => {
  caller = new AbortController()
  vi.spyOn(execution, 'resolveGitHubRepoExecution').mockResolvedValue({
    ownerRepo: repository,
    ghOptions: { host: repository.host }
  })
  vi.spyOn(rateLimit, 'repositoryRateLimitGuard').mockReturnValue({ blocked: false })
  await Promise.all(Array.from({ length: 4 }, () => gh.acquire()))
  vi.spyOn(gh, 'acquire')
  vi.spyOn(gh, 'release')
  vi.useFakeTimers()
})

afterEach(() => {
  caller.abort()
  for (let slot = 0; slot < 4; slot += 1) {
    gh.release()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Actions reads waiting for a GitHub operation slot', () => {
  it('preserves an acquisition failure when the caller has not aborted', async () => {
    const reason = new Error('Semaphore unavailable')
    vi.mocked(gh.acquire).mockRejectedValueOnce(reason)
    const read = vi.fn()
    await expect(withActionsRead('/repo', repository, null, {}, caller.signal, read)).rejects.toBe(
      reason
    )
    expect(read).not.toHaveBeenCalled()
    expect(gh.release).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    {
      timeoutMs: GITHUB_CHECK_DETAILS_HOST_TIMEOUT_MS,
      message: GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE
    },
    { timeoutMs: ACTIONS_ARTIFACT_HOST_TIMEOUT_MS, message: ACTIONS_ARTIFACT_TIMEOUT_MESSAGE }
  ])('preserves the queued deadline reason: $message', async (deadline) => {
    const read = vi.fn().mockResolvedValue('read completed')
    const pending = withActionsRead('/repo', repository, null, {}, caller.signal, read, deadline)
    const outcome = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(gh.acquire).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(deadline.timeoutMs)
    expect(await outcome).toMatchObject({ message: deadline.message })
    expect(read).not.toHaveBeenCalled()
    expect(gh.release).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    for (let slot = 0; slot < 4; slot += 1) {
      gh.release()
    }
    await Promise.all(Array.from({ length: 4 }, () => gh.acquire()))
    expect(read).not.toHaveBeenCalled()
  })

  it('preserves explicit cancellation and removes the canceled waiter', async () => {
    const read = vi.fn().mockResolvedValue('read completed')
    const reason = new Error('Caller disconnected')
    const pending = withActionsRead('/repo', repository, null, {}, caller.signal, read)
    const outcome = pending.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(gh.acquire).toHaveBeenCalledOnce()
    caller.abort(reason)
    expect(await outcome).toBe(reason)
    expect(read).not.toHaveBeenCalled()
    expect(gh.release).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    for (let slot = 0; slot < 4; slot += 1) {
      gh.release()
    }
    await Promise.all(Array.from({ length: 4 }, () => gh.acquire()))
    expect(read).not.toHaveBeenCalled()
  })
})
