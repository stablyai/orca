import { beforeEach, expect, it, vi } from 'vitest'
import type * as LocalWorktreeFilesystem from './local-worktree-filesystem'
const { prove, missing, remove } = vi.hoisted(() => ({
  prove: vi.fn(),
  missing: vi.fn(),
  remove: vi.fn()
}))
vi.mock('./local-worktree-filesystem', async (importOriginal) => {
  const actual = await importOriginal<typeof LocalWorktreeFilesystem>()
  return {
    ...actual,
    prepareLocalWorktreeFilesystem: async (
      ...args: Parameters<typeof actual.prepareLocalWorktreeFilesystem>
    ) => ({ ...(await actual.prepareLocalWorktreeFilesystem(...args)), remove })
  }
})
vi.mock('./worktree-removal-safety', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  canSafelyRemoveOrphanedWorktreeDirectory: prove,
  isWorktreePathMissing: missing
}))
import { cleanupLocalOrphanedWorktreeDirectory } from './local-orphaned-worktree-cleanup'
beforeEach(() => {
  prove.mockReset().mockResolvedValue(true)
  missing.mockReset().mockResolvedValue(true)
  remove.mockReset().mockResolvedValue(undefined)
})
it.each(['proof', 'watcher', 'delete', 'success'] as const)(
  'does not convert cancelled orphan cleanup into absent-path success at %s',
  async (phase) => {
    const controller = new AbortController()
    if (phase === 'proof') {
      prove.mockImplementationOnce(async () => {
        controller.abort()
        return true
      })
    }
    const watcher = vi.fn(async () => {
      if (phase === 'watcher') {
        controller.abort()
      }
    })
    remove.mockImplementationOnce(async () => {
      if (phase !== 'success') {
        controller.abort()
      }
      if (phase === 'delete') {
        throw controller.signal.reason
      }
    })
    const pending = cleanupLocalOrphanedWorktreeDirectory(
      '/repo',
      '/repo/feature',
      {},
      watcher,
      controller.signal
    )
    if (phase === 'success') {
      await expect(pending).resolves.toBeUndefined()
      expect(missing).toHaveBeenCalledOnce()
    } else {
      const error = await pending.catch((error: unknown) => error)
      expect(error).toBe(controller.signal.reason)
      expect(missing).not.toHaveBeenCalled()
    }
    if (phase === 'proof' || phase === 'watcher') {
      expect(remove).not.toHaveBeenCalled()
    }
  }
)
