import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetWslAutomountRootsForTests } from '../../wsl/filesystem/wsl-automount-root'
import { settleWslAutomountRoot } from '../../wsl/filesystem/__fixtures__/wsl-automount-root-fixture'
import type * as WorktreeRemovalSafety from './worktree-removal-safety'
import type * as LocalWorktreeFilesystem from './local-worktree-filesystem'
const { prove, missing, remove, runProcessMock } = vi.hoisted(() => ({
  prove: vi.fn(),
  missing: vi.fn(),
  remove: vi.fn(),
  runProcessMock: vi.fn()
}))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))
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
beforeEach(async () => {
  resetWslAutomountRootsForTests()
  const actual = await vi.importActual<typeof WorktreeRemovalSafety>('./worktree-removal-safety')
  prove.mockReset().mockResolvedValue(true)
  missing.mockReset().mockImplementation(actual.isWorktreePathMissing)
  runProcessMock.mockReset().mockResolvedValue({
    code: 1,
    signal: null,
    timedOut: false,
    stdout: '',
    stderr: "stat: cannot statx '/qamnt/c/repo/feature': No such file or directory\n"
  })
  remove.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  resetWslAutomountRootsForTests()
})
it.each(['proof', 'watcher', 'delete', 'success', 'epoch'] as const)(
  'does not convert cancelled orphan cleanup into absent-path success at %s',
  async (phase) => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      await settleWslAutomountRoot('Ubuntu', '/qamnt/')
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
        if (phase !== 'epoch') {
          controller.abort()
        }
        if (phase === 'delete') {
          throw controller.signal.reason
        }
      })
      if (phase === 'epoch') {
        const actual = await vi.importActual<typeof WorktreeRemovalSafety>(
          './worktree-removal-safety'
        )
        missing.mockImplementationOnce(async (...args) => {
          const absent = await actual.isWorktreePathMissing(...args)
          resetWslAutomountRootsForTests()
          return absent
        })
      }
      const pending = cleanupLocalOrphanedWorktreeDirectory(
        'C:/repo',
        'C:/repo/feature',
        { wslDistro: 'Ubuntu' },
        watcher,
        controller.signal
      )
      if (phase === 'success') {
        await expect(pending).resolves.toBeUndefined()
        expect(missing).toHaveBeenCalledOnce()
      } else if (phase === 'epoch') {
        await expect(pending).rejects.toThrow('Ubuntu')
      } else {
        const error = await pending.catch((error: unknown) => error)
        expect(error).toBe(controller.signal.reason)
        expect(missing).not.toHaveBeenCalled()
      }
      if (phase === 'proof' || phase === 'watcher') {
        expect(remove).not.toHaveBeenCalled()
      }
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  }
)
