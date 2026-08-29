import { describe, expect, it, vi } from 'vitest'
import {
  enoent,
  openMock,
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
  '../ipc/rg-availability',
  async () => (await import('./orca-runtime-files-mock-registry')).rgAvailabilityMock
)
vi.mock(
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./orca-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
)
vi.mock(
  '../ipc/filesystem-search-git',
  async () => (await import('./orca-runtime-files-mock-registry')).filesystemSearchGitMock
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
      undefined
    )
    expect(result).toEqual({
      worktree: 'wt-1',
      relativePath: 'docs/readme.md',
      kind: 'markdown',
      opened: true
    })
  })

  // The read is capped at the budget, so `byteLength` describes the prefix, not
  // the file. Only a stat the host actually performed may be reported as a size.
  it('reports the observed file size when a local runtime read is truncated', async () => {
    const { commands } = createRuntimeFileCommands({})
    resolveAuthorizedPathMock.mockResolvedValue('/repo/docs/huge.log')
    statMock.mockResolvedValue({ isDirectory: () => false, size: 4 * 1024 * 1024 * 1024 })
    openMock.mockResolvedValue({
      read: (buffer: Buffer, offset: number, length: number) => {
        buffer.fill(0x78, offset, offset + length)
        return Promise.resolve({ bytesRead: length })
      },
      close: () => Promise.resolve()
    })

    const result = await commands.readMobileFile('id:wt-1', 'docs/huge.log')

    expect(result.truncated).toBe(true)
    expect(result.byteLength).toBe(512 * 1024 + 1)
    expect(result.totalByteLength).toBe(4 * 1024 * 1024 * 1024)
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
      undefined
    )
    expect(result).toEqual({
      worktree: 'wt-1',
      relativePath: 'assets/logo.png',
      kind: 'image',
      opened: true
    })
  })

  it('leaves non-previewable binaries unavailable on mobile', async () => {
    const openFile = vi.fn()
    const { commands } = createRuntimeFileCommands({ openFile })

    const result = await commands.openMobileFile('id:wt-1', 'dist/bundle.zip')

    expect(openFile).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    expect(result).toEqual({
      worktree: 'wt-1',
      relativePath: 'dist/bundle.zip',
      kind: 'binary',
      opened: false
    })
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
      connectionId: 'ssh-1'
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
