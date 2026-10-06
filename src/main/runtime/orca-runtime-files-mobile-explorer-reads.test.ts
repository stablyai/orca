import { describe, expect, it, vi } from 'vitest'
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
      undefined
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
      undefined
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
      undefined
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
      'all'
    )
    expect(openDiff).toHaveBeenCalledWith(
      'wt-1',
      '/repo/docs/readme.md',
      'docs/readme.md',
      false,
      undefined,
      'host'
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
        undefined
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
})
