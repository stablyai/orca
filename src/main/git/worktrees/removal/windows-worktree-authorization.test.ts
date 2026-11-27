import { lstatSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/concurrency/abort-signal-reason'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'

const {
  graph,
  stat,
  statBigInt,
  names,
  removeChild,
  unlink,
  rmdir,
  clean,
  readMarker,
  proveOrphan
} = vi.hoisted(() => ({
  graph: vi.fn(),
  stat: vi.fn(),
  statBigInt: vi.fn(),
  names: vi.fn(),
  removeChild: vi.fn(),
  unlink: vi.fn(),
  rmdir: vi.fn(),
  clean: vi.fn(),
  readMarker: vi.fn(),
  proveOrphan: vi.fn()
}))
vi.mock('../catalog/worktree-list-reader', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readTranslatedWorktreeGraph: graph
}))
vi.mock('../../../filesystem/asar-transparent-fs', () => ({
  lstat: stat,
  lstatBigInt: statBigInt,
  readdir: names,
  rm: removeChild,
  unlink,
  rmdir
}))
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readFile: readMarker
}))
vi.mock('../../../workspaces/removal/worktree-removal-safety', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  canSafelyRemoveOrphanedWorktreeDirectory: proveOrphan
}))
vi.mock('./worktree-removal-preflight', () => ({ assertWorktreeCleanForRemoval: clean }))

import { removeWindowsCheckout } from './windows-worktree-removal'
import { removeUnregisteredHostCheckout } from '../../../filesystem/host-tree-removal'
import { _resetWorktreeScanCacheForTests } from '../catalog/worktree-scan-cache'

const originalPlatform = process.platform
const root = 'C:/checkout/feature'
const row: GitWorktreeInfo = {
  path: root,
  branch: 'refs/heads/feature',
  head: 'abc',
  isBare: false,
  isMainWorktree: false
}
const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  _resetWorktreeScanCacheForTests()
  graph.mockResolvedValue([row])
  stat.mockImplementation(async (path: string) => {
    if (String(path).endsWith('locked')) {
      throw missing
    }
    return { isDirectory: () => true, isSymbolicLink: () => false, dev: 1, ino: 1 }
  })
  statBigInt.mockImplementation(async (path: string) => {
    if (String(path).endsWith('locked')) {
      throw missing
    }
    return { isDirectory: () => true, isSymbolicLink: () => false, dev: 1n, ino: 1n }
  })
  names.mockResolvedValue(['held', '.git'])
  removeChild.mockResolvedValue(undefined)
  unlink.mockResolvedValue(undefined)
  rmdir.mockResolvedValue(undefined)
  clean.mockResolvedValue(undefined)
  readMarker.mockImplementation(async (path: string) =>
    String(path).startsWith(tmpdir())
      ? readFileSync(String(path), 'utf8')
      : 'gitdir: C:/repo/.git/worktrees/feature'
  )
  proveOrphan.mockResolvedValue(true)
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  vi.resetAllMocks()
  _resetWorktreeScanCacheForTests()
})

it('joins held children before cancelling the real repeated delete-time authorization', async () => {
  const controller = new AbortController()
  const sibling = Promise.withResolvers<void>()
  const childrenStarted = Promise.withResolvers<void>()
  const repeated = Promise.withResolvers<void>()
  let settled = false
  removeChild.mockImplementation(async () => {
    childrenStarted.resolve()
    await sibling.promise
  })
  // Initial clean authorization and its recursive proof, then the post-child recheck.
  graph
    .mockImplementationOnce(async () => [row])
    .mockImplementationOnce(async () => [row])
    .mockImplementationOnce(async (_repo, options) => {
      repeated.resolve()
      await waitForPromiseWithSignal(new Promise<never>(() => {}), options.signal)
      throwIfSignalAborted(options.signal)
      return [row]
    })
  const pending = removeWindowsCheckout('C:/repo', root, false, {
    checkoutDeleteSignal: controller.signal
  })
  const outcome = pending
    .finally(() => {
      settled = true
    })
    .catch((error: unknown) => error)
  await childrenStarted.promise
  expect(settled).toBe(false)
  expect(unlink).not.toHaveBeenCalled()
  sibling.resolve()
  await repeated.promise
  const reason = new Error('owner stopped during repeated proof')
  controller.abort(reason)
  expect(await outcome).toBe(reason)
  expect(unlink).not.toHaveBeenCalled()
  expect(rmdir).not.toHaveBeenCalled()
})

it('refuses before sweeping children when a checkout replaces the pinned marker during ownership proof', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'orca-win-auth-race-'))
  try {
    const gitFile = join(scratch, '.git')
    writeFileSync(gitFile, 'gitdir: C:/repo/.git/worktrees/feature\n')
    const initialIno = lstatSync(gitFile, { bigint: true }).ino
    graph.mockResolvedValue([])
    proveOrphan.mockImplementationOnce(async () => {
      unlinkSync(gitFile)
      writeFileSync(gitFile, 'gitdir: C:/repo/.git/worktrees/restored\n')
      readMarker.mockResolvedValue('gitdir: C:/repo/.git/worktrees/restored\n')
      return true
    })

    await expect(
      removeWindowsCheckout('C:/repo', scratch, true, {
        expectedMarker: `C:/repo/.git/worktrees/feature#${initialIno}`
      })
    ).rejects.toThrow('A different checkout is now at')

    expect(proveOrphan).toHaveBeenCalled()
    expect(removeChild).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

it('refuses before sweeping children when a checkout replaces the pinned marker during directory enumeration', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'orca-win-readdir-race-'))
  try {
    const gitFile = join(scratch, '.git')
    writeFileSync(gitFile, 'gitdir: C:/repo/.git/worktrees/feature\n')
    const initialIno = lstatSync(gitFile, { bigint: true }).ino
    names.mockImplementationOnce(async () => {
      unlinkSync(gitFile)
      writeFileSync(gitFile, 'gitdir: C:/repo/.git/worktrees/restored\n')
      return ['unsaved.txt', '.git']
    })

    await expect(
      removeWindowsCheckout('C:/repo', scratch, true, {
        expectedMarker: `C:/repo/.git/worktrees/feature#${initialIno}`
      })
    ).rejects.toThrow('A different checkout is now at')

    expect(names).toHaveBeenCalled()
    expect(removeChild).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

it('skips child deletion and refuses non-empty folder when the pinned marker disappears during enumeration', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'orca-win-readdir-loss-'))
  try {
    const gitFile = join(scratch, '.git')
    writeFileSync(gitFile, 'gitdir: C:/repo/.git/worktrees/feature\n')
    const initialIno = lstatSync(gitFile, { bigint: true }).ino
    names.mockImplementationOnce(async () => {
      unlinkSync(gitFile)
      stat.mockImplementation(async (path: string) => {
        if (String(path).endsWith('.git') || String(path).endsWith('locked')) {
          throw missing
        }
        return { isDirectory: () => true, isSymbolicLink: () => false }
      })
      rmdir.mockRejectedValue(Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' }))
      return ['unsaved.txt']
    })

    await expect(
      removeWindowsCheckout('C:/repo', scratch, true, {
        expectedMarker: `C:/repo/.git/worktrees/feature#${initialIno}`
      })
    ).rejects.toThrow('is no longer a Git worktree')

    expect(removeChild).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

it('refuses before sweeping children when a markerless root becomes a symlink during enumeration', async () => {
  stat.mockImplementation(async (path: string) => {
    if (String(path).endsWith('.git')) {
      throw missing
    }
    return { isDirectory: () => true, isSymbolicLink: () => false, dev: 1, ino: 1 }
  })
  statBigInt.mockImplementation(async (path: string) => {
    if (String(path).endsWith('.git')) {
      throw missing
    }
    return { isDirectory: () => true, isSymbolicLink: () => false, dev: 1n, ino: 1n }
  })
  names.mockImplementationOnce(async () => {
    statBigInt.mockImplementation(async (path: string) => {
      if (String(path).endsWith('.git')) {
        throw missing
      }
      return { isDirectory: () => false, isSymbolicLink: () => true, dev: 1n, ino: 1n }
    })
    return ['notes.txt']
  })

  await expect(
    removeUnregisteredHostCheckout('/work/feature', undefined, { forbidAnyMarker: true })
  ).rejects.toThrow('Refusing to delete unregistered worktree path')

  expect(names).toHaveBeenCalledTimes(1)
  expect(removeChild).not.toHaveBeenCalled()
})

it('distinguishes 64-bit directory inode IDs above Number.MAX_SAFE_INTEGER when rechecking root identity', async () => {
  let rootIno = 9_007_199_254_745_092n
  stat.mockImplementation(async (path: string) => {
    if (String(path).endsWith('.git')) {
      throw missing
    }
    return { isDirectory: () => true, isSymbolicLink: () => false, dev: 1, ino: Number(rootIno) }
  })
  statBigInt.mockImplementation(async (path: string) => {
    if (String(path).endsWith('.git')) {
      throw missing
    }
    return { isDirectory: () => true, isSymbolicLink: () => false, dev: 1n, ino: rootIno }
  })
  names.mockImplementationOnce(async () => {
    rootIno = 9_007_199_254_745_093n
    return ['notes.txt']
  })

  await expect(
    removeUnregisteredHostCheckout('/work/feature', undefined, { forbidAnyMarker: true })
  ).rejects.toThrow('A different checkout is now at')

  expect(names).toHaveBeenCalledTimes(1)
  expect(removeChild).not.toHaveBeenCalled()
})
