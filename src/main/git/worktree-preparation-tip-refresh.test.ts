import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  verify: vi.fn(),
  verifyAt: vi.fn(),
  mutation: vi.fn(),
  invalidation: vi.fn()
}))
vi.mock('./runner', () => ({ gitExecFileAsync: mocks.git }))
vi.mock('./worktree', () => ({ notifyPreparedWorktreeMutation: mocks.mutation }))
vi.mock('./status', () => ({ runWithGitReadCacheInvalidation: mocks.invalidation }))
vi.mock('./local-repo-ref-maintenance', () => ({
  withRepoRefMaintenancePaused: (_reason: string, run: () => Promise<unknown>) => run()
}))
vi.mock('./worktree-preparation-lock', () => ({
  verifyWorktreePreparationLock: mocks.verify,
  verifyWorktreePreparationLockAtPath: mocks.verifyAt
}))

import { refreshPreparedWorktreeTip } from './worktree-preparation-tip-refresh'

const OLD = 'a'.repeat(40)
const NEW = 'b'.repeat(40)
const BASE = 'refs/remotes/origin/main'

beforeEach(() => {
  mocks.git.mockReset().mockImplementation(async (args: string[], options: { cwd?: string }) => ({
    stdout: args[0] === 'rev-parse' && options.cwd === '/repo' ? `${NEW}\n` : `${OLD}\n`
  }))
  mocks.verify.mockReset().mockResolvedValue('/repo/.git/worktrees/prepared/locked')
  mocks.verifyAt.mockReset().mockImplementation(async (_lock, _reason, signal?: AbortSignal) => {
    signal?.throwIfAborted()
  })
  mocks.mutation.mockReset()
  mocks.invalidation.mockReset().mockImplementation((run: () => Promise<unknown>) => run())
})

describe('prepared checkout fetched tip materialization', () => {
  it('does no index or file mutation when the fetched tip is unchanged', async () => {
    mocks.git.mockResolvedValue({ stdout: `${OLD}\n` })
    await refreshPreparedWorktreeTip('/repo', '/prepared', BASE, 'owner')
    expect(mocks.git.mock.calls.map(([args]) => args)).toEqual([
      ['rev-parse', '--verify', `${BASE}^{commit}`],
      ['rev-parse', '--verify', 'HEAD']
    ])
    expect(mocks.invalidation).not.toHaveBeenCalled()
    expect(mocks.mutation).not.toHaveBeenCalled()
  })

  it('resets only to the fetched commit on the owning WSL host without checkout hooks', async () => {
    const signal = new AbortController().signal
    await refreshPreparedWorktreeTip('/repo', '/prepared', BASE, 'owner', {
      wslDistro: 'Ubuntu',
      admissionTier: 'status',
      signal
    })
    expect(mocks.git).toHaveBeenLastCalledWith(
      ['reset', '--hard', NEW],
      expect.objectContaining({
        cwd: '/prepared',
        wslDistro: 'Ubuntu',
        admissionTier: 'status',
        signal
      })
    )
    expect(mocks.git.mock.calls.some(([args]) => args.includes('checkout'))).toBe(false)
    expect(mocks.verifyAt).toHaveBeenCalledTimes(2)
    expect(mocks.mutation).toHaveBeenCalledOnce()
  })

  it('stops before any probe when the stored lock belongs to another owner', async () => {
    mocks.verify.mockRejectedValueOnce(new Error('ownership lost'))
    await expect(refreshPreparedWorktreeTip('/repo', '/prepared', BASE, 'owner')).rejects.toThrow(
      'ownership lost'
    )
    expect(mocks.git).not.toHaveBeenCalled()
  })

  it('rechecks ownership after both reads before touching files', async () => {
    mocks.verifyAt.mockRejectedValueOnce(new Error('ownership changed during probes'))
    await expect(refreshPreparedWorktreeTip('/repo', '/prepared', BASE, 'owner')).rejects.toThrow(
      'ownership changed'
    )
    expect(mocks.git).toHaveBeenCalledTimes(2)
    expect(mocks.invalidation).not.toHaveBeenCalled()
  })

  it('settles both probes before reporting a failed ref read', async () => {
    let release!: () => void
    mocks.git
      .mockRejectedValueOnce(new Error('base unavailable'))
      .mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve({ stdout: OLD })))
      )
    let settled = false
    const refresh = refreshPreparedWorktreeTip('/repo', '/prepared', BASE, 'owner').finally(() => {
      settled = true
    })
    const assertion = expect(refresh).rejects.toThrow('base unavailable')
    await vi.waitFor(() => expect(mocks.git).toHaveBeenCalledTimes(2))
    expect(settled).toBe(false)
    release()
    await assertion
    expect(mocks.invalidation).not.toHaveBeenCalled()
  })

  it('honors cancellation between probes and materialization', async () => {
    const controller = new AbortController()
    mocks.git.mockImplementation(async (_args: string[], options: { cwd?: string }) => {
      controller.abort()
      return { stdout: options.cwd === '/repo' ? NEW : OLD }
    })
    await expect(
      refreshPreparedWorktreeTip('/repo', '/prepared', BASE, 'owner', { signal: controller.signal })
    ).rejects.toThrow()
    expect(mocks.git).toHaveBeenCalledTimes(2)
    expect(mocks.invalidation).not.toHaveBeenCalled()
  })
})
