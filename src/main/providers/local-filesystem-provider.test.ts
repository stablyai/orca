import { tryAcquireConditionalWorktreeRemoval } from '../ipc/conditional-worktree-removal-lease'
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { createLocalFilesystemProvider } from './local-filesystem-provider'

vi.mock('../ipc/local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: vi.fn()
}))
vi.mock('../ipc/markdown-documents', () => ({ listMarkdownDocuments: vi.fn() }))
vi.mock('../ripgrep/bundled-ripgrep-text-search', () => ({ runBundledRipgrepTextSearch: vi.fn() }))
vi.mock('../ripgrep/bundled-ripgrep-wsl-routing', () => ({
  resolveBundledRipgrepWslRouting: vi.fn()
}))

let root: string
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider reads only settings from the store; authorization is the injected stub.
const store = {
  getSettings: () => ({ followSymlinkedDirectories: true })
} as unknown as RuntimeStore
const authorize = vi.fn(async (path: string, _store: RuntimeStore, _options?: unknown) => path)
const provider = () =>
  createLocalFilesystemProvider({ requireStore: () => store, resolveAuthorizedPath: authorize })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-local-fs-provider-'))
  authorize.mockClear()
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('createLocalFilesystemProvider', () => {
  it('authorizes every path against the injected store before touching it', async () => {
    const file = join(root, 'a', 'b.txt')
    await provider().writeFileBase64(file, Buffer.from('hi').toString('base64'))
    await provider().writeFileBase64Chunk(file, Buffer.from('!').toString('base64'), true)
    expect(await readFile(file, 'utf8')).toBe('hi!')
    expect(authorize).toHaveBeenCalledWith(file, store)
    await expect(provider().writeFileBase64(file, '')).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('keeps the runtime create and write guards', async () => {
    await provider().createFile(join(root, 'x.txt'))
    await expect(provider().createFile(join(root, 'x.txt'))).rejects.toThrow(
      "A file or folder named 'x.txt' already exists in this location"
    )
    await provider().createDir(join(root, 'dir'))
    await expect(provider().createDir(join(root, 'dir'))).rejects.toThrow(/already exists/)
    await expect(provider().writeFile(join(root, 'dir'), 'x')).rejects.toThrow(
      'Cannot write to a directory'
    )
    const stat = await provider().stat(join(root, 'dir'))
    expect(stat).toMatchObject({ type: 'directory', mtime: expect.any(Number) })
    expect(stat.ctimeMs).toEqual(expect.any(Number))
  })

  // Why: creating symlinks needs elevated rights on Windows runners.
  it.skipIf(process.platform === 'win32')(
    'renames, copies and deletes a symlink itself rather than its target',
    async () => {
      const target = join(root, 'target.txt')
      const link = join(root, 'link.txt')
      await writeFile(target, 'body')
      await symlink(target, link)
      await provider().renameNoClobber(link, join(root, 'moved.txt'))
      expect(await readlink(join(root, 'moved.txt'))).toBe(target)
      await provider().copy(target, join(root, 'nested', 'copy.txt'))
      await expect(provider().copy(target, join(root, 'nested', 'copy.txt'))).rejects.toMatchObject(
        { code: 'EEXIST' }
      )
      await provider().deletePath(join(root, 'moved.txt'))
      expect(await readFile(target, 'utf8')).toBe('body')
      for (const call of authorize.mock.calls.filter(([path]) => path !== target)) {
        expect(call[2]).toEqual({ preserveSymlink: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'follows symlinked directories by the store setting unless the caller overrides it',
    async () => {
      await mkdir(join(root, 'real'))
      await symlink(join(root, 'real'), join(root, 'alias'))
      const isAliasDir = async (followSymlinks?: boolean) =>
        (await provider().readDir(root, { followSymlinks })).find((entry) => entry.name === 'alias')
          ?.isDirectory
      expect(await isAliasDir()).toBe(true)
      expect(await isAliasDir(false)).toBe(false)
    }
  )
})

describe('conditional removal file mutation exclusion', () => {
  it('refuses each mutation before authorization while removal is closing', async () => {
    const admission = tryAcquireConditionalWorktreeRemoval(root)
    if (admission.kind !== 'acquired') {
      throw new Error('Removal admission failed')
    }
    const fs = provider()
    const path = join(root, 'file.txt')
    try {
      for (const operation of [
        () => fs.writeFile(path, 'body'),
        () => fs.writeFileWithDiskPrecondition(path, 'body', undefined),
        () => fs.writeFileBase64(path, ''),
        () => fs.writeFileBase64Chunk(path, '', true),
        () => fs.createFile(path),
        () => fs.createDir(path),
        () => fs.createDirNoClobber(path),
        () => fs.deletePath(path),
        () => fs.renameNoClobber(path, join(root, 'renamed.txt')),
        () => fs.copy(path, join(root, 'copied.txt'))
      ]) {
        await expect(operation()).rejects.toMatchObject({
          code: 'conditional_worktree_removal_in_progress'
        })
      }
      expect(authorize).not.toHaveBeenCalled()
    } finally {
      admission.release()
    }
  })

  it('keeps admission busy until an already admitted write finishes or fails', async () => {
    let resume: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      resume = resolve
    })
    authorize.mockImplementationOnce(async (path) => {
      await pending
      return path
    })
    const write = provider().writeFile(join(root, 'saved.txt'), 'body')
    expect(tryAcquireConditionalWorktreeRemoval(root)).toEqual({ kind: 'busy' })
    resume?.()
    await write
    const admission = tryAcquireConditionalWorktreeRemoval(root)
    if (admission.kind !== 'acquired') {
      throw new Error('Mutation lease was not released')
    }
    admission.release()
    authorize.mockRejectedValueOnce(new Error('authorization failed'))
    await expect(provider().createFile(join(root, 'failed.txt'))).rejects.toThrow(
      'authorization failed'
    )
    const afterFailure = tryAcquireConditionalWorktreeRemoval(root)
    if (afterFailure.kind !== 'acquired') {
      throw new Error('Failed mutation lease was not released')
    }
    afterFailure.release()
  })
})
