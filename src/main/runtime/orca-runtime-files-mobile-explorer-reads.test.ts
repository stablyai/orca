import { describe, expect, it, vi } from 'vitest'
import type * as FileSystem from 'node:fs/promises'
import {
  enoent,
  readdirMock,
  resolveAuthorizedPathMock,
  statMock
} from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem-auth', async () =>
  (await import('./orca-runtime-files-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./orca-runtime-files-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./orca-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./orca-runtime-files-mock-registry')).sshFilesystemDispatchMock
)

function dirEntry(args: { name: string; directory?: boolean; symlink?: boolean }) {
  return {
    name: args.name,
    isDirectory: () => args.directory ?? false,
    isSymbolicLink: () => args.symlink ?? false
  }
}

describe('RuntimeFileCommands', () => {
  useRuntimeFileCommandsLifecycle()

  it('returns the authorized local file change time for media consistency checks', async () => {
    const { commands } = createRuntimeFileCommands()
    resolveAuthorizedPathMock.mockResolvedValue('/repo/video.mp4')
    statMock.mockResolvedValue({ size: 3, mtimeMs: 1, ctimeMs: 2, isDirectory: () => false })
    expect(await commands.statRuntimeFile('id:wt-1', 'video.mp4')).toEqual({
      size: 3,
      isDirectory: false,
      mtime: 1,
      ctime: 2
    })
    expect(resolveAuthorizedPathMock).toHaveBeenCalled()
    expect(statMock).toHaveBeenCalledWith('/repo/video.mp4')
  })

  it('detects a real same-size rewrite even after restoring the modification time', async () => {
    vi.useRealTimers()
    const files = await vi.importActual<typeof FileSystem>('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const root = await files.mkdtemp(join(tmpdir(), 'orca-media-revision-'))
    const filePath = join(root, 'video.mp4')
    try {
      await files.writeFile(filePath, 'abc')
      await files.utimes(filePath, 1, 2)
      const { commands } = createRuntimeFileCommands()
      resolveAuthorizedPathMock.mockResolvedValue(filePath)
      statMock.mockImplementation((path: string) => files.stat(path))
      const before = await commands.statRuntimeFile('id:wt-1', 'video.mp4')
      await new Promise((resolve) => setTimeout(resolve, 20))
      await files.writeFile(filePath, 'xyz')
      await files.utimes(filePath, 1, 2)
      const after = await commands.statRuntimeFile('id:wt-1', 'video.mp4')
      expect(after.size).toBe(before.size)
      expect(after.mtime).toBe(before.mtime)
      expect(after.ctime).not.toBe(before.ctime)
    } finally {
      await files.rm(root, { recursive: true, force: true })
    }
  })

  it('opens source control diffs through the renderer host (inheriting active runtime env)', async () => {
    const openDiff = vi.fn()
    const { commands } = createRuntimeFileCommands({ openDiff })

    const result = await commands.openMobileDiff('id:wt-1', 'docs/readme.md', true)

    expect(openDiff).toHaveBeenCalledWith(
      'wt-1',
      '/repo/docs/readme.md',
      'docs/readme.md',
      true,
      undefined,
      undefined,
      { authority: 'window', executionHostId: 'local' }
    )
    expect(result).toEqual({
      worktree: 'wt-1',
      relativePath: 'docs/readme.md',
      kind: 'markdown',
      opened: true
    })
  })

  it('opens text files through the renderer host (inheriting active runtime env)', async () => {
    const openFile = vi.fn()
    const { commands } = createRuntimeFileCommands({ openFile })
    resolveAuthorizedPathMock.mockResolvedValue('/repo/docs/readme.md')
    statMock.mockResolvedValue({ isDirectory: () => false })

    const result = await commands.openMobileFile('id:wt-1', 'docs/readme.md')

    expect(openFile).toHaveBeenCalledWith(
      'wt-1',
      '/repo/docs/readme.md',
      'docs/readme.md',
      undefined,
      undefined,
      { authority: 'window', executionHostId: 'local' }
    )
    expect(result).toEqual({
      worktree: 'wt-1',
      relativePath: 'docs/readme.md',
      kind: 'markdown',
      opened: true
    })
  })

  it('opens previewable images through the renderer host as an image tab', async () => {
    const openFile = vi.fn()
    const { commands } = createRuntimeFileCommands({ openFile })
    resolveAuthorizedPathMock.mockResolvedValue('/repo/assets/logo.png')
    statMock.mockResolvedValue({ isDirectory: () => false })

    const result = await commands.openMobileFile('id:wt-1', 'assets/logo.png')

    expect(openFile).toHaveBeenCalledWith(
      'wt-1',
      '/repo/assets/logo.png',
      'assets/logo.png',
      undefined,
      undefined,
      { authority: 'window', executionHostId: 'local' }
    )
    expect(result).toEqual({
      worktree: 'wt-1',
      relativePath: 'assets/logo.png',
      kind: 'image',
      opened: true
    })
  })

  it('passes the caller navigation target to the renderer host', async () => {
    const openFile = vi.fn()
    const openDiff = vi.fn()
    const { commands } = createRuntimeFileCommands({ openFile, openDiff })
    resolveAuthorizedPathMock.mockResolvedValue('/repo/docs/readme.md')
    statMock.mockResolvedValue({ isDirectory: () => false })

    await commands.openMobileFile('id:wt-1', 'docs/readme.md', 'all')
    await commands.openMobileDiff('id:wt-1', 'docs/readme.md', false, 'host')

    expect(openFile).toHaveBeenCalledWith(
      'wt-1',
      '/repo/docs/readme.md',
      'docs/readme.md',
      undefined,
      'all',
      { authority: 'window', executionHostId: 'local' }
    )
    expect(openDiff).toHaveBeenCalledWith(
      'wt-1',
      '/repo/docs/readme.md',
      'docs/readme.md',
      false,
      undefined,
      'host',
      { authority: 'window', executionHostId: 'local' }
    )
  })

  it.each(['docs/example.pdf', 'dist/bundle.zip'])(
    'opens binary %s in the desktop editor like the File Explorer does',
    async (relativePath) => {
      const openFile = vi.fn()
      const { commands } = createRuntimeFileCommands({ openFile })
      resolveAuthorizedPathMock.mockResolvedValue(`/repo/${relativePath}`)
      statMock.mockResolvedValue({ isDirectory: () => false })

      const result = await commands.openMobileFile('id:wt-1', relativePath)

      expect(openFile).toHaveBeenCalledWith(
        'wt-1',
        `/repo/${relativePath}`,
        relativePath,
        undefined,
        undefined,
        { authority: 'window', executionHostId: 'local' }
      )
      expect(result).toEqual({ worktree: 'wt-1', relativePath, kind: 'binary', opened: true })
    }
  )

  it('rejects a missing binary instead of opening a ghost tab', async () => {
    const openFile = vi.fn()
    const { commands } = createRuntimeFileCommands({ openFile })
    resolveAuthorizedPathMock.mockResolvedValue('/repo/docs/missing.pdf')
    statMock.mockRejectedValue(enoent())

    await expect(commands.openMobileFile('id:wt-1', 'docs/missing.pdf')).rejects.toThrow(
      "ENOENT: no such file or directory, open '/repo/docs/missing.pdf'"
    )
    expect(openFile).not.toHaveBeenCalled()
  })

  it('rejects missing local files without creating an editor tab', async () => {
    const openFile = vi.fn()
    const { commands } = createRuntimeFileCommands({ openFile })
    resolveAuthorizedPathMock.mockResolvedValue('/repo/docs/missing.md')
    statMock.mockRejectedValue(enoent())

    await expect(commands.openMobileFile('id:wt-1', 'docs/missing.md')).rejects.toThrow(
      "ENOENT: no such file or directory, open '/repo/docs/missing.md'"
    )
    expect(openFile).not.toHaveBeenCalled()
  })

  it('rejects missing remote files without creating an editor tab', async () => {
    const openFile = vi.fn()
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1',
        path: '/remote/repo'
      },
      executionHostId: 'ssh:ssh-1'
    }))
    const { commands } = createRuntimeFileCommands({
      openFile,
      path: '/remote/repo',
      resolveRuntimeFileTarget
    })
    vi.mocked(getSshFilesystemProvider).mockReturnValue({
      stat: vi.fn().mockRejectedValue(new Error('ENOENT: no such file or directory'))
    } as never)

    await expect(commands.openMobileFile('id:wt-1', 'docs/missing.md')).rejects.toThrow(
      "ENOENT: no such file or directory, open '/remote/repo/docs/missing.md'"
    )
    expect(openFile).not.toHaveBeenCalled()
  })

  it('rejects a local directory without creating an editor tab', async () => {
    const openFile = vi.fn()
    const { commands } = createRuntimeFileCommands({ openFile })
    resolveAuthorizedPathMock.mockResolvedValue('/repo/docs/notes.pdf')
    statMock.mockResolvedValue({ isDirectory: () => true })

    await expect(commands.openMobileFile('id:wt-1', 'docs/notes.pdf')).rejects.toThrow(
      "EISDIR: illegal operation on a directory, open '/repo/docs/notes.pdf'"
    )
    expect(openFile).not.toHaveBeenCalled()
  })

  it('rejects a remote directory without creating an editor tab', async () => {
    const openFile = vi.fn()
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1',
        path: '/remote/repo'
      },
      executionHostId: 'ssh:ssh-1'
    }))
    const { commands } = createRuntimeFileCommands({
      openFile,
      path: '/remote/repo',
      resolveRuntimeFileTarget
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the open path only calls `stat`.
    vi.mocked(getSshFilesystemProvider).mockReturnValue({
      stat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtime: 0 })
    } as never)

    await expect(commands.openMobileFile('id:wt-1', 'src')).rejects.toThrow(
      "EISDIR: illegal operation on a directory, open '/remote/repo/src'"
    )
    expect(openFile).not.toHaveBeenCalled()
  })

  it('does not follow symlinks when reading runtime-local file explorer dirs', async () => {
    const { commands } = createRuntimeFileCommands()
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    readdirMock.mockResolvedValue([
      dirEntry({ name: 'README.md' }),
      dirEntry({ name: 'linked-docs', directory: true, symlink: true })
    ])

    const result = await commands.readFileExplorerDir('id:wt-1', '')

    expect(result).toEqual([
      { name: 'linked-docs', isDirectory: false, isSymlink: true },
      { name: 'README.md', isDirectory: false, isSymlink: false }
    ])
    expect(statMock).not.toHaveBeenCalledWith('/repo/linked-docs')
  })
  it.each([
    { setting: true, override: undefined, expected: true },
    { setting: true, override: false, expected: false },
    { setting: false, override: true, expected: true }
  ])(
    'applies runtime symlink setting $setting with override $override',
    async ({ setting, override, expected }) => {
      const { commands, store } = createRuntimeFileCommands()
      store.getSettings.mockReturnValue({ followSymlinkedDirectories: setting })
      resolveAuthorizedPathMock.mockImplementation(async (path) => path)
      readdirMock.mockResolvedValue([dirEntry({ name: 'linked-docs', symlink: true })])
      statMock.mockResolvedValue({ isDirectory: () => true })

      await expect(
        commands.readFileExplorerDir('id:wt-1', '', { followSymlinks: override })
      ).resolves.toEqual([{ name: 'linked-docs', isDirectory: expected, isSymlink: true }])
      expect(store.getSettings).toHaveBeenCalledTimes(override === undefined ? 1 : 0)
      if (expected) {
        expect(statMock).toHaveBeenCalledWith('/repo/linked-docs')
      } else {
        expect(statMock).not.toHaveBeenCalled()
      }
    }
  )
})
