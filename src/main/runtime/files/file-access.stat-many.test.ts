import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeFileAccess } from './file-access'
import type { RuntimeFileCommandHost } from './file-command-host'
import type { RuntimeFileExplorerPath } from './file-target'
import type * as FileTargetModule from './file-target'
import type * as ChatScratchFileRootModule from './chat-scratch-file-root'

const { resolveFileExplorerPaths } = vi.hoisted(() => ({
  resolveFileExplorerPaths: vi.fn<
    (
      host: unknown,
      worktreeSelector: string,
      relativePaths: readonly string[]
    ) => Promise<
      (Pick<RuntimeFileExplorerPath, 'path' | 'executionHostId'> & {
        worktree: { path: string }
      })[]
    >
  >()
}))

// Worktree resolution is out of scope here: map selectors straight onto a temp root. The
// provider and stat only read each target's path, host id and worktree path.
vi.mock('./file-target', async (importOriginal) => ({
  ...(await importOriginal<typeof FileTargetModule>()),
  resolveFileExplorerPaths
}))

// Repository-based authorization needs a full store; authorize paths inside the temp root only.
const authorizedRoots: string[] = []
vi.mock('./chat-scratch-file-root', async (importOriginal) => ({
  ...(await importOriginal<typeof ChatScratchFileRootModule>()),
  resolveRuntimeAuthorizedPath: async (targetPath: string) => {
    if (!authorizedRoots.some((root) => targetPath.startsWith(`${root}/`))) {
      throw new Error(`Unauthorized path: ${targetPath}`)
    }
    return targetPath
  }
}))

type RuntimeFileAccessHost = Pick<
  RuntimeFileCommandHost,
  'requireStore' | 'resolveRuntimeFileTarget' | 'openFile' | 'openDiff'
>

function unexpected(name: string): () => never {
  return () => {
    throw new Error(`${name} should not be called by statManyRuntimeFiles`)
  }
}

function createHost(): RuntimeFileAccessHost {
  return {
    // The local provider reads the store lazily and hands it to the (mocked) authorizer.
    requireStore: vi.fn<RuntimeFileAccessHost['requireStore']>(),
    resolveRuntimeFileTarget: unexpected('resolveRuntimeFileTarget'),
    openFile: unexpected('openFile'),
    openDiff: unexpected('openDiff')
  }
}

function useRoot(root: string): void {
  authorizedRoots.push(root)
  resolveFileExplorerPaths.mockImplementation(async (_host, _selector, relativePaths) =>
    relativePaths.map((relativePath) => ({
      path: join(root, relativePath),
      executionHostId: 'local',
      worktree: { path: root }
    }))
  )
}

const dirs: string[] = []
afterEach(async () => {
  authorizedRoots.splice(0)
  resolveFileExplorerPaths.mockReset()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('files.statMany (statManyRuntimeFiles)', () => {
  it('stats a batch in order: files, directories and absent paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stat-many-'))
    dirs.push(root)
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'a.ts'), 'hello')
    useRoot(root)
    const access = new RuntimeFileAccess(createHost())
    const { entries } = await access.statManyRuntimeFiles('wt-1', [
      'src/a.ts',
      'src',
      'missing.txt'
    ])
    expect(entries[0]).toMatchObject({ size: 5, type: 'file', mtime: expect.any(Number) })
    expect(entries[1]).toMatchObject({ type: 'directory' })
    expect(entries[2]).toBeNull()
  })

  it('refuses batches over the limit', async () => {
    useRoot('/repo')
    const access = new RuntimeFileAccess(createHost())
    await expect(
      access.statManyRuntimeFiles(
        'wt-1',
        Array.from({ length: 2001 }, (_, i) => `f${i}`)
      )
    ).rejects.toThrow('Invalid stat batch')
    expect(resolveFileExplorerPaths).not.toHaveBeenCalled()
  })
})
