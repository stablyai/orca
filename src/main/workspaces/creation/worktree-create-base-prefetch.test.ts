import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getBaseRefDefault: vi.fn(),
  gitExecFileAsync: vi.fn(),
  resolveRemoteTrackingBase: vi.fn(),
  hasRemoteTrackingRef: vi.fn(),
  getOrStartRemoteTrackingBaseRefresh: vi.fn(),
  fetchRemoteWithCache: vi.fn()
}))

vi.mock('../../git/repo-default-base-ref', () => ({ getBaseRefDefault: mocks.getBaseRefDefault }))
vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: mocks.gitExecFileAsync
}))

import { prefetchWorktreeCreateBase } from './worktree-create-base-prefetch'

const repo = {
  id: 'repo-1',
  path: String.raw`C:\workspace\repo`,
  displayName: 'repo',
  badgeColor: '#000000',
  addedAt: 0
}

const WSL = { wslDistro: 'Ubuntu' }

function runtime() {
  return {
    resolveRemoteTrackingBase: mocks.resolveRemoteTrackingBase,
    hasRemoteTrackingRef: mocks.hasRemoteTrackingRef,
    getOrStartRemoteTrackingBaseRefresh: mocks.getOrStartRemoteTrackingBaseRefresh,
    fetchRemoteWithCache: mocks.fetchRemoteWithCache
  }
}

function resolveOnly(present: string[]): void {
  mocks.gitExecFileAsync.mockImplementation(async (args: string[]) => {
    const rev = args.at(-1)?.replace('^{commit}', '') ?? ''
    return present.includes(rev)
      ? { stdout: `${'f'.repeat(40)}\n`, stderr: '' }
      : { stdout: '', stderr: '' }
  })
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
  mocks.getBaseRefDefault.mockResolvedValue('origin/main')
  resolveOnly([])
  mocks.resolveRemoteTrackingBase.mockResolvedValue(null)
  mocks.hasRemoteTrackingRef.mockResolvedValue(false)
  mocks.getOrStartRemoteTrackingBaseRefresh.mockResolvedValue({ ok: true })
  mocks.fetchRemoteWithCache.mockResolvedValue(undefined)
})

describe('checkout and refresh overlap', () => {
  it.each([{}, WSL])(
    'starts one checkout with a shared refresh barrier before fetch settles on %j',
    async (gitOptions) => {
      const base = {
        remote: 'origin',
        branch: 'main',
        ref: 'refs/remotes/origin/main',
        base: 'origin/main'
      }
      mocks.resolveRemoteTrackingBase.mockResolvedValue(base)
      mocks.hasRemoteTrackingRef.mockResolvedValue(true)
      let release!: () => void
      mocks.getOrStartRemoteTrackingBaseRefresh.mockImplementation(
        () =>
          new Promise<{ ok: boolean }>((resolve) => {
            release = () => resolve({ ok: true })
          })
      )
      let materialized = false
      const prepareCheckout = vi.fn(
        async (_base: string, beforeMaterialization?: Promise<void>) => {
          await beforeMaterialization
          materialized = true
        }
      )
      let settled = false
      const result = prefetchWorktreeCreateBase({
        repo,
        baseBranch: 'origin/main',
        runtime: runtime(),
        gitOptions,
        prepareCheckout
      }).finally(() => {
        settled = true
      })
      await vi.waitFor(() =>
        expect(prepareCheckout).toHaveBeenCalledWith('origin/main', expect.any(Promise))
      )
      expect(settled).toBe(false)
      expect(materialized).toBe(false)
      expect(mocks.getOrStartRemoteTrackingBaseRefresh).toHaveBeenCalledOnce()
      release()
      await expect(result).resolves.toBe('origin/main')
      expect(materialized).toBe(true)
      expect(prepareCheckout).toHaveBeenCalledOnce()
    }
  )

  it('settles preparation before propagating refresh failure', async () => {
    mocks.resolveRemoteTrackingBase.mockResolvedValue({
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    })
    mocks.hasRemoteTrackingRef.mockResolvedValue(true)
    const error = new Error('refresh failed')
    mocks.getOrStartRemoteTrackingBaseRefresh.mockRejectedValue(error)
    let release!: () => void
    const prepareCheckout = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    let settled = false
    const result = prefetchWorktreeCreateBase({
      repo,
      baseBranch: 'origin/main',
      runtime: runtime(),
      gitOptions: {},
      prepareCheckout
    }).finally(() => {
      settled = true
    })
    const assertion = expect(result).rejects.toBe(error)
    await vi.waitFor(() => expect(prepareCheckout).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    release()
    await assertion
  })

  it('settles the materialization barrier on fetch failure without hiding the fetch error', async () => {
    mocks.resolveRemoteTrackingBase.mockResolvedValue({
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    })
    mocks.hasRemoteTrackingRef.mockResolvedValue(true)
    const error = new Error('offline')
    mocks.getOrStartRemoteTrackingBaseRefresh.mockRejectedValue(error)
    let materialized = false
    const prepareCheckout = vi.fn(async (_base: string, beforeMaterialization?: Promise<void>) => {
      await beforeMaterialization
      materialized = true
    })
    await expect(
      prefetchWorktreeCreateBase({
        repo,
        baseBranch: 'origin/main',
        runtime: runtime(),
        gitOptions: {},
        prepareCheckout
      })
    ).rejects.toBe(error)
    expect(materialized).toBe(true)
    expect(prepareCheckout).toHaveBeenCalledOnce()
    expect(mocks.getOrStartRemoteTrackingBaseRefresh).toHaveBeenCalledOnce()
  })
})
