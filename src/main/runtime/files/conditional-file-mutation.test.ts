import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { tryAcquireConditionalWorktreeRemoval } from '../../ipc/conditional-worktree-removal-lease'
import { RuntimeFileMutations } from './file-mutations'

const mocks = vi.hoisted(() => ({ resolvePath: vi.fn(), resolvePaths: vi.fn() }))
vi.mock('./file-target', () => ({
  resolveFileExplorerPath: mocks.resolvePath,
  resolveFileExplorerPaths: mocks.resolvePaths,
  requireLocalRuntimeFileRoute: vi.fn(),
  requireRuntimeFileProvider: vi.fn()
}))
vi.mock('./chat-scratch-file-root', () => ({ resolveRuntimeAuthorizedPath: vi.fn() }))
let root: string
const host = {
  requireStore: () => {
    throw new Error('Store must not be read')
  },
  resolveRuntimeFileTarget: async () => {
    throw new Error('No target')
  }
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-file-mutation-'))
  vi.resetAllMocks()
})
afterEach(() => rm(root, { recursive: true, force: true }))

it('refuses all runtime mutations before resolving any target during closing', async () => {
  const admission = tryAcquireConditionalWorktreeRemoval(root)
  if (admission.kind !== 'acquired') {
    throw new Error('Removal admission failed')
  }
  const files = new RuntimeFileMutations(host)
  try {
    for (const operation of [
      () => files.writeFileExplorerFile('worktree', 'file', 'body'),
      () => files.writeFileExplorerFileBase64('worktree', 'file', ''),
      () => files.writeFileExplorerFileBase64Chunk('worktree', 'file', '', true),
      () => files.createFileExplorerFile('worktree', 'file'),
      () => files.createFileExplorerDir('worktree', 'dir'),
      () => files.createFileExplorerDirNoClobber('worktree', 'dir'),
      () => files.commitFileExplorerUpload('worktree', 'temp', 'final'),
      () => files.renameFileExplorerPath('worktree', 'old', 'new'),
      () => files.copyFileExplorerPath('worktree', 'source', 'destination'),
      () => files.deleteFileExplorerPath('worktree', 'file')
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: 'conditional_worktree_removal_in_progress'
      })
    }
    expect(mocks.resolvePath).not.toHaveBeenCalled()
    expect(mocks.resolvePaths).not.toHaveBeenCalled()
  } finally {
    admission.release()
  }
})

it('keeps removal busy through asynchronous target resolution and releases on failure', async () => {
  let reject: ((error: Error) => void) | undefined
  mocks.resolvePath.mockReturnValueOnce(
    new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise
    })
  )
  const write = new RuntimeFileMutations(host).writeFileExplorerFile('worktree', 'file', 'body')
  expect(tryAcquireConditionalWorktreeRemoval(root)).toEqual({ kind: 'busy' })
  reject?.(new Error('Target resolution failed'))
  await expect(write).rejects.toThrow('Target resolution failed')
  const admission = tryAcquireConditionalWorktreeRemoval(root)
  if (admission.kind !== 'acquired') {
    throw new Error('Failed resolver leaked a lease')
  }
  admission.release()
})
