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
import { bindPluginHostServices } from '../plugins/plugin-host-service-bindings'

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

  it('resolves plugin file authority through the SSH provider on every request', async () => {
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/remote/repo' },
      executionHostId: 'ssh:ssh-1'
    }))
    const { commands } = createRuntimeFileCommands({
      path: '/remote/repo',
      resolveRuntimeFileTarget
    })
    const realpath = vi.fn(async (path: string) => `/canonical${path}`)
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ realpath } as never)

    await expect(
      commands.resolvePluginFileAuthority('identity:opaque', 'docs/readme.md')
    ).resolves.toEqual({
      canonicalRoot: '/canonical/remote/repo',
      canonicalTarget: '/canonical/remote/repo/docs/readme.md'
    })
    await commands.resolvePluginFileAuthority('identity:opaque', 'docs/readme.md')

    expect(realpath).toHaveBeenCalledTimes(4)
    expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
  })

  it('returns fresh provider stat metadata through the plugin service on every request', async () => {
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/remote/repo' },
      executionHostId: 'ssh:ssh-1'
    }))
    const { commands } = createRuntimeFileCommands({ resolveRuntimeFileTarget })
    const realpath = vi.fn(async (path: string) => `/canonical${path}`)
    const stat = vi
      .fn()
      .mockResolvedValueOnce({ size: 5, type: 'file', mtime: 100 })
      .mockResolvedValueOnce({ size: 9, type: 'file', mtime: 200 })
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ realpath, stat } as never)
    const services = bindPluginHostServices({
      delegate: {
        listPluginWorkspaces: vi.fn().mockResolvedValue({ workspaces: [] }),
        resolveActiveWorktreeContext: vi.fn(),
        listTerminals: vi.fn(),
        sendTerminal: vi.fn(),
        dispatchPluginNotification: vi.fn(),
        executePluginFileMethod: (...args) => commands.executePluginFileMethod(...args)
      },
      pluginsDataDir: '/plugins',
      subscribeEvents: vi.fn()
    })
    const params = {
      workspaceRef: { type: 'worktree' as const, identity: 'opaque' },
      relativePath: 'docs/readme.md'
    }
    const grant = { kind: 'files:read' as const, paths: ['docs/**'] }

    await expect(
      services.executeAuthorizedPluginHostCall('files.stat', params, grant)
    ).resolves.toEqual({
      authorized: true,
      value: { size: 5, isDirectory: false, mtime: 100 }
    })
    await expect(
      services.executeAuthorizedPluginHostCall('files.stat', params, grant)
    ).resolves.toEqual({
      authorized: true,
      value: { size: 9, isDirectory: false, mtime: 200 }
    })

    expect(resolveRuntimeFileTarget).toHaveBeenCalledTimes(2)
    expect(realpath).toHaveBeenCalledTimes(4)
    expect(stat).toHaveBeenCalledTimes(2)
    expect(stat).toHaveBeenNthCalledWith(1, '/canonical/remote/repo/docs/readme.md')
    expect(stat).toHaveBeenNthCalledWith(2, '/canonical/remote/repo/docs/readme.md')
    expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
  })

  it('reports SSH directory symlinks as non-directories to match local traversal', async () => {
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/remote/repo' },
      executionHostId: 'ssh:ssh-1'
    }))
    const { commands } = createRuntimeFileCommands({ resolveRuntimeFileTarget })
    const readDir = vi.fn().mockResolvedValue([
      { name: 'docs-link', isDirectory: true, isSymlink: true },
      { name: 'docs', isDirectory: true, isSymlink: false },
      { name: 'README.md', isDirectory: false, isSymlink: false }
    ])
    vi.mocked(getSshFilesystemProvider).mockReturnValue({
      realpath: vi.fn(async (path: string) => path),
      readDir
    } as never)

    await expect(
      commands.executePluginFileMethod('files.readDir', 'identity:opaque', '', {
        paths: ['**']
      })
    ).resolves.toEqual({
      authorized: true,
      value: {
        entries: [
          { name: 'docs', isDirectory: true },
          { name: 'docs-link', isDirectory: false },
          { name: 'README.md', isDirectory: false }
        ]
      }
    })
    expect(readDir).toHaveBeenCalledWith('/remote/repo')
    expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
  })

  it.each(['files.read', 'files.stat', 'files.readDir'] as const)(
    'refuses hostile SSH canonicalization for %s without remote content or local fallback',
    async (method) => {
      const { commands } = createRuntimeFileCommands({
        resolveRuntimeFileTarget: vi.fn(async () => ({
          worktree: { id: 'wt-1', repoId: 'repo-1', path: '/remote/repo' },
          executionHostId: 'ssh:ssh-1'
        }))
      })
      const realpath = vi
        .fn()
        .mockResolvedValueOnce('/canonical/repo')
        .mockResolvedValueOnce('/canonical/elsewhere/secret.txt')
      const readFile = vi.fn()
      const providerStat = vi.fn()
      const readDir = vi.fn()
      vi.mocked(getSshFilesystemProvider).mockReturnValue({
        realpath,
        readFile,
        stat: providerStat,
        readDir
      } as never)

      await expect(
        commands.executePluginFileMethod(method, 'identity:opaque', 'docs/link.txt', {
          paths: ['docs/**']
        })
      ).resolves.toEqual({ authorized: false })
      expect(readFile).not.toHaveBeenCalled()
      expect(providerStat).not.toHaveBeenCalled()
      expect(readDir).not.toHaveBeenCalled()
      expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
      expect(openMock).not.toHaveBeenCalled()
      expect(statMock).not.toHaveBeenCalled()
      expect(readdirMock).not.toHaveBeenCalled()
    }
  )

  it('fails explicitly when plugin SSH authority has no provider without local fallback', async () => {
    const { commands } = createRuntimeFileCommands({
      resolveRuntimeFileTarget: vi.fn(async () => ({
        worktree: { id: 'wt-1', repoId: 'repo-1', path: '/remote/repo' },
        executionHostId: 'ssh:ssh-1'
      }))
    })
    vi.mocked(getSshFilesystemProvider).mockReturnValue(undefined)

    await expect(
      commands.resolvePluginFileAuthority('identity:opaque', 'docs/readme.md')
    ).rejects.toThrow('Remote connection dropped')
    expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
  })

  it.each(['files.read', 'files.stat', 'files.readDir'] as const)(
    'executes %s against the canonical target and captured SSH provider after mapping mutation',
    async (method) => {
      let mappedPath = '/remote/repo'
      const resolveRuntimeFileTarget = vi.fn(async () => ({
        worktree: { id: 'wt-1', repoId: 'repo-1', path: mappedPath },
        executionHostId: 'ssh:ssh-1'
      }))
      const { commands } = createRuntimeFileCommands({ resolveRuntimeFileTarget })
      const readFile = vi.fn().mockResolvedValue({ content: 'safe', isBinary: false })
      const stat = vi.fn().mockResolvedValue({ size: 4, type: 'file', mtime: 1 })
      const readDir = vi.fn().mockResolvedValue([])
      const provider = {
        realpath: vi.fn(async (path: string) => {
          if (path.endsWith('docs/readme.md')) {
            mappedPath = '/remote/outside'
          }
          return `/canonical${path}`
        }),
        readFile,
        stat,
        readDir
      }
      const outsideProvider = { readFile: vi.fn(), stat: vi.fn(), readDir: vi.fn() }
      vi.mocked(getSshFilesystemProvider).mockImplementation(() =>
        mappedPath === '/remote/repo' ? (provider as never) : (outsideProvider as never)
      )

      await expect(
        commands.executePluginFileMethod(method, 'identity:opaque', 'docs/readme.md', {
          paths: ['docs/**']
        })
      ).resolves.toMatchObject({ authorized: true })

      expect(resolveRuntimeFileTarget).toHaveBeenCalledOnce()
      const operation =
        method === 'files.read' ? readFile : method === 'files.stat' ? stat : readDir
      expect(operation).toHaveBeenCalledWith('/canonical/remote/repo/docs/readme.md')
      expect(outsideProvider.readFile).not.toHaveBeenCalled()
      expect(outsideProvider.stat).not.toHaveBeenCalled()
      expect(outsideProvider.readDir).not.toHaveBeenCalled()
      expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
    }
  )

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
