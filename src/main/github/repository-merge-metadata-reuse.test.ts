import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { exec, guard, spend } = vi.hoisted(() => ({ exec: vi.fn(), guard: vi.fn(), spend: vi.fn() }))
vi.mock('./gh-utils', () => ({ ghExecFileAsync: exec }))
vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: guard,
  noteRepositoryRateLimitSpend: spend
}))

import { detectRepositoryMergeMetadata } from './client/detect/repository-merge-metadata'
import { _resetMergeQueueCacheForTests } from './client/detect/repository-merge-metadata-cache'

const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const options = { cwd: '/repo' }

function response(autoMergeAllowed: boolean): { stdout: string } {
  return {
    stdout: JSON.stringify({
      data: { repository: { autoMergeAllowed, mergeQueue: null, ref: { rules: { nodes: [] } } } }
    })
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('GH_CONFIG_DIR', undefined)
  vi.stubEnv('XDG_CONFIG_HOME', undefined)
  _resetMergeQueueCacheForTests()
  guard.mockReturnValue({ blocked: false })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('repository merge metadata reuse', () => {
  it.each([true, false])(
    'retains a successful concurrent read when a newer read fails (failure first: %s)',
    async (failureFirst) => {
      const older = Promise.withResolvers<{ stdout: string }>()
      const newer = Promise.withResolvers<{ stdout: string }>()
      exec.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
      const first = detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
      const second = detectRepositoryMergeMetadata(
        repository,
        'main',
        { cwd: '/another-worktree' },
        'local:host'
      )
      if (failureFirst) {
        newer.reject(new Error('ECONNRESET'))
        await second
        older.resolve(response(true))
        await first
      } else {
        older.resolve(response(true))
        await first
        newer.reject(new Error('ECONNRESET'))
        await second
      }
      await expect(
        detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
      ).resolves.toMatchObject({ autoMergeAllowed: true })
      expect(exec).toHaveBeenCalledTimes(2)
    }
  )

  it('does not couple independent abort signals or cache an aborted result', async () => {
    const canceled = Promise.withResolvers<{ stdout: string }>()
    const surviving = Promise.withResolvers<{ stdout: string }>()
    const firstController = new AbortController()
    const secondController = new AbortController()
    exec.mockReturnValueOnce(canceled.promise).mockReturnValueOnce(surviving.promise)
    const first = detectRepositoryMergeMetadata(
      repository,
      'main',
      { ...options, signal: firstController.signal },
      'local:host'
    )
    const second = detectRepositoryMergeMetadata(
      repository,
      'main',
      { ...options, signal: secondController.signal },
      'local:host'
    )
    expect(exec).toHaveBeenCalledTimes(2)
    firstController.abort()
    canceled.reject(firstController.signal.reason)
    await expect(first).resolves.toMatchObject({ autoMergeAllowed: null })
    surviving.resolve(response(false))
    await expect(second).resolves.toMatchObject({ autoMergeAllowed: false })
    await expect(
      detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    ).resolves.toMatchObject({ autoMergeAllowed: false })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('retries immediately with a new signal after the only probe aborts', async () => {
    const canceled = Promise.withResolvers<{ stdout: string }>()
    const controller = new AbortController()
    exec.mockReturnValueOnce(canceled.promise).mockResolvedValueOnce(response(true))
    const first = detectRepositoryMergeMetadata(
      repository,
      'main',
      { ...options, signal: controller.signal },
      'local:host'
    )
    controller.abort()
    canceled.reject(controller.signal.reason)
    await first

    await expect(
      detectRepositoryMergeMetadata(
        repository,
        'main',
        { ...options, signal: new AbortController().signal },
        'local:host'
      )
    ).resolves.toMatchObject({ autoMergeAllowed: true })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('retains a surviving cache writer when a newer independent probe aborts', async () => {
    const older = Promise.withResolvers<{ stdout: string }>()
    const canceled = Promise.withResolvers<{ stdout: string }>()
    const controller = new AbortController()
    exec.mockReturnValueOnce(older.promise).mockReturnValueOnce(canceled.promise)
    const first = detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    const second = detectRepositoryMergeMetadata(
      repository,
      'main',
      { ...options, signal: controller.signal },
      'local:host'
    )
    controller.abort()
    canceled.reject(controller.signal.reason)
    await second
    older.resolve(response(false))
    await first

    await expect(
      detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    ).resolves.toMatchObject({ autoMergeAllowed: false })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('does not spend quota for an already aborted probe', async () => {
    const controller = new AbortController()
    controller.abort()
    exec.mockResolvedValue(response(true))

    await expect(
      detectRepositoryMergeMetadata(
        repository,
        'main',
        { ...options, signal: controller.signal },
        'local:host'
      )
    ).resolves.toMatchObject({ autoMergeAllowed: null })
    expect(exec).not.toHaveBeenCalled()
    expect(spend).not.toHaveBeenCalled()
  })

  it('keeps newer worktree settings when an older directory probe completes later', async () => {
    const older = Promise.withResolvers<{ stdout: string }>()
    const newer = Promise.withResolvers<{ stdout: string }>()
    exec.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const first = detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    const second = detectRepositoryMergeMetadata(
      repository,
      'main',
      { cwd: '/another-worktree' },
      'local:host'
    )

    newer.resolve(response(false))
    await expect(second).resolves.toMatchObject({ autoMergeAllowed: false })
    older.resolve(response(true))
    await expect(first).resolves.toMatchObject({ autoMergeAllowed: true })
    await expect(
      detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    ).resolves.toMatchObject({ autoMergeAllowed: false })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('allows a stale successor without letting the older completion replace its cache', async () => {
    vi.useFakeTimers()
    const older = Promise.withResolvers<{ stdout: string }>()
    const newer = Promise.withResolvers<{ stdout: string }>()
    exec.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const first = detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    vi.advanceTimersByTime(60_000)
    const second = detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')

    newer.resolve(response(false))
    await expect(second).resolves.toMatchObject({ autoMergeAllowed: false })
    older.resolve(response(true))
    await expect(first).resolves.toMatchObject({ autoMergeAllowed: true })
    await expect(
      detectRepositoryMergeMetadata(repository, 'main', options, 'local:host')
    ).resolves.toMatchObject({ autoMergeAllowed: false })
    expect(exec).toHaveBeenCalledTimes(2)
  })
})
