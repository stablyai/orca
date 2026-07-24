/* eslint-disable max-lines -- Why: runtime file command tests share mocked fs,
   authorization, and watcher lifecycle fixtures; splitting would duplicate the
   setup that makes cross-command filesystem behavior comparable. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { link, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as Fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import type * as FilesystemAuth from '../ipc/filesystem-auth'
import type * as GitRunner from '../git/runner'

const {
  lstatMock,
  openMock,
  readdirMock,
  renameMock,
  resolveAuthorizedPathMock,
  statMock,
  watchInWatcherProcessMock,
  closeWatcherInWatcherProcessMock,
  checkRgAvailableMock,
  getLocalGitOptionsForRegisteredWorktreeMock,
  wslAwareSpawnMock,
  watchMock
} = vi.hoisted(() => ({
  checkRgAvailableMock: vi.fn(),
  getLocalGitOptionsForRegisteredWorktreeMock: vi.fn(),
  lstatMock: vi.fn(),
  openMock: vi.fn(),
  readdirMock: vi.fn(),
  renameMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  statMock: vi.fn(),
  watchInWatcherProcessMock: vi.fn(),
  closeWatcherInWatcherProcessMock: vi.fn(),
  wslAwareSpawnMock: vi.fn(),
  watchMock: vi.fn()
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof Fs>('fs')
  return {
    ...actual,
    watch: watchMock
  }
})

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return {
    ...actual,
    lstat: lstatMock,
    open: (...args: Parameters<typeof actual.open>) => {
      const impl = openMock.getMockImplementation()
      return impl ? openMock(...args) : actual.open(...args)
    },
    readdir: readdirMock,
    rename: renameMock,
    stat: statMock
  }
})

vi.mock('./file-watcher-host', () => ({
  closeFileExplorerWatcherInWatcherProcess: closeWatcherInWatcherProcessMock,
  watchFileExplorerInWatcherProcess: watchInWatcherProcessMock
}))

vi.mock('../ipc/filesystem-auth', async () => {
  const actual = await vi.importActual<typeof FilesystemAuth>('../ipc/filesystem-auth')
  return {
    ...actual,
    resolveAuthorizedPath: resolveAuthorizedPathMock
  }
})

vi.mock('../git/runner', async () => {
  const actual = await vi.importActual<typeof GitRunner>('../git/runner')
  return {
    ...actual,
    wslAwareSpawn: wslAwareSpawnMock
  }
})

vi.mock('../ipc/rg-availability', () => ({
  checkRgAvailable: checkRgAvailableMock
}))

vi.mock('../ipc/local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn(),
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE:
    'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
}))

import { awaitRuntimeFileWatcherUnsubscribes, RuntimeFileCommands } from './orca-runtime-files'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import {
  resetSshConnectionGenerations,
  setSshConnectionGeneration
} from '../ssh/ssh-connection-generation'
import { SEARCH_TIMEOUT_MS } from '../../shared/text-search'

type MockRuntimeSearchChild = EventEmitter & {
  stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

function enoent(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

function mockStats(dev: number, ino: number) {
  return { dev, ino, isDirectory: () => false }
}

function dirEntry(args: { name: string; directory?: boolean; symlink?: boolean }) {
  return {
    name: args.name,
    isDirectory: () => args.directory ?? false,
    isSymbolicLink: () => args.symlink ?? false
  }
}

function mockLocalPathStats(entries: Record<string, [number, number]>) {
  resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
  lstatMock.mockImplementation(async (p: string) => {
    const entry = entries[p]
    if (entry) {
      return mockStats(entry[0], entry[1])
    }
    throw enoent()
  })
}

function createRuntimeFileCommands(options?: {
  path?: string
  openFile?: ReturnType<typeof vi.fn>
  openDiff?: ReturnType<typeof vi.fn>
  resolveRuntimeFileTarget?: ReturnType<typeof vi.fn>
  resolveRuntimeGitTarget?: ReturnType<typeof vi.fn>
  resolveTerminalCwd?: ReturnType<typeof vi.fn>
  resolveTerminalContext?: ReturnType<typeof vi.fn>
  resolveTerminalFileUriHostname?: ReturnType<typeof vi.fn>
  hasRecentTerminalOutputPath?: ReturnType<typeof vi.fn>
}) {
  const store = {
    getRepo: vi.fn((_repoId?: string) => undefined as { connectionId?: string } | undefined)
  }
  const path = options?.path ?? '/repo'
  const worktree = {
    id: 'wt-1',
    repoId: 'repo-1',
    path
  }
  const commands = new RuntimeFileCommands({
    getRuntimeId: () => 'runtime-1',
    requireStore: () => store,
    resolveWorktreeSelector: vi.fn(async () => worktree),
    resolveRuntimeFileTarget:
      options?.resolveRuntimeFileTarget ??
      vi.fn(async () => ({
        worktree,
        connectionId: store.getRepo(worktree.repoId)?.connectionId
      })),
    resolveTerminalCwd: options?.resolveTerminalCwd ?? vi.fn(() => path),
    resolveTerminalContext:
      options?.resolveTerminalContext ??
      vi.fn(() => ({
        worktreeId: worktree.id,
        connectionId: store.getRepo(worktree.repoId)?.connectionId ?? null
      })),
    ...(options?.resolveTerminalFileUriHostname
      ? { resolveTerminalFileUriHostname: options.resolveTerminalFileUriHostname }
      : {}),
    hasRecentTerminalOutputPath: options?.hasRecentTerminalOutputPath ?? vi.fn(() => true),
    resolveRuntimeGitTarget: options?.resolveRuntimeGitTarget ?? vi.fn(),
    openFile: options?.openFile ?? vi.fn(),
    ...(options?.openDiff ? { openDiff: options.openDiff } : {})
  } as never)
  return { commands, store }
}

function createRuntimeSearchChild(): MockRuntimeSearchChild {
  const child = new EventEmitter() as MockRuntimeSearchChild
  child.stdout = new EventEmitter() as MockRuntimeSearchChild['stdout']
  child.stdout.setEncoding = vi.fn()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

describe('RuntimeFileCommands', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.useFakeTimers()
    lstatMock.mockReset()
    openMock.mockReset()
    readdirMock.mockReset()
    renameMock.mockReset()
    resolveAuthorizedPathMock.mockReset()
    statMock.mockReset()
    watchInWatcherProcessMock.mockReset()
    closeWatcherInWatcherProcessMock.mockReset()
    watchMock.mockReset()
    checkRgAvailableMock.mockReset()
    vi.mocked(getSshFilesystemProvider).mockReset()
    resetSshConnectionGenerations()
    getLocalGitOptionsForRegisteredWorktreeMock.mockReset()
    wslAwareSpawnMock.mockReset()
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({})
    readdirMock.mockResolvedValue([])
    lstatMock.mockRejectedValue(enoent())
    renameMock.mockResolvedValue(undefined)
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  afterEach(async () => {
    await awaitRuntimeFileWatcherUnsubscribes()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
    vi.useRealTimers()
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

  it('renames a runtime-local file when destination does not exist', async () => {
    const { commands } = createRuntimeFileCommands()
    resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

    await commands.renameFileExplorerPath(
      'id:wt-1',
      'old.ts',
      'new.ts',
      undefined,
      undefined,
      'local'
    )

    expect(renameMock).toHaveBeenCalledWith('/repo/old.ts', '/repo/new.ts')
  })

  it('rejects legacy paired local mutations before selecting a filesystem provider', async () => {
    const { commands } = createRuntimeFileCommands()

    await expect(commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts')).rejects.toThrow(
      'newer Orca client'
    )

    expect(getSshFilesystemProvider).not.toHaveBeenCalled()
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects legacy paired SSH mutations before selecting a filesystem provider', async () => {
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', 0, 'ssh-1')
    ).rejects.toThrow('newer Orca client')

    expect(getSshFilesystemProvider).not.toHaveBeenCalled()
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects a local expectation when the worktree moved to SSH', async () => {
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', undefined, undefined, 'local')
    ).rejects.toThrow('Workspace host changed')

    expect(getSshFilesystemProvider).not.toHaveBeenCalled()
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects an SSH expectation when the worktree moved to HUB-local', async () => {
    const { commands } = createRuntimeFileCommands()

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', 0, 'ssh-1', 'ssh:ssh-1')
    ).rejects.toThrow('Workspace host changed')

    expect(getSshFilesystemProvider).not.toHaveBeenCalled()
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('allows runtime-local case-only rename with IPC parity guard behavior', async () => {
    const { commands } = createRuntimeFileCommands()
    mockLocalPathStats({
      '/repo/README.md': [10, 100],
      '/repo/readme.md': [10, 100]
    })

    await commands.renameFileExplorerPath(
      'id:wt-1',
      'README.md',
      'readme.md',
      undefined,
      undefined,
      'local'
    )

    expect(renameMock).toHaveBeenCalledWith('/repo/README.md', '/repo/readme.md')
  })

  it('rejects runtime-local true destination collisions', async () => {
    const { commands } = createRuntimeFileCommands()
    mockLocalPathStats({
      '/repo/old.ts': [11, 110],
      '/repo/new.ts': [11, 111]
    })

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', undefined, undefined, 'local')
    ).rejects.toThrow("A file or folder named 'new.ts' already exists in this location")

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects runtime-local hard-link alias collisions', async () => {
    const { commands } = createRuntimeFileCommands()
    mockLocalPathStats({
      '/repo/README.md': [12, 120],
      '/repo/README-hardlink.md': [12, 120]
    })

    await expect(
      commands.renameFileExplorerPath(
        'id:wt-1',
        'README.md',
        'README-hardlink.md',
        undefined,
        undefined,
        'local'
      )
    ).rejects.toThrow("A file or folder named 'README-hardlink.md' already exists in this location")

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects runtime-local cross-parent case-only collisions', async () => {
    const { commands } = createRuntimeFileCommands()
    mockLocalPathStats({
      '/repo/src/README.md': [13, 130],
      '/repo/docs/readme.md': [13, 130]
    })

    await expect(
      commands.renameFileExplorerPath(
        'id:wt-1',
        'src/README.md',
        'docs/readme.md',
        undefined,
        undefined,
        'local'
      )
    ).rejects.toThrow("A file or folder named 'readme.md' already exists in this location")

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('routes runtime remote rename through the SSH no-clobber provider method', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ renameNoClobber } as never)
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', 0, 'ssh-1', 'ssh:ssh-1')

    expect(renameNoClobber).toHaveBeenCalledWith('/repo/old.ts', '/repo/new.ts')
    expect(store.getRepo).toHaveBeenCalledTimes(1)
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects a mutation captured for an obsolete SSH connection generation', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ renameNoClobber } as never)
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
    setSshConnectionGeneration('ssh-1', 8)

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', 7, 'ssh-1', 'ssh:ssh-1')
    ).rejects.toThrow('SSH connection changed')
    expect(renameNoClobber).not.toHaveBeenCalled()
  })

  it('rejects nested SSH mutations from clients without generation support', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ renameNoClobber } as never)
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await expect(
      commands.renameFileExplorerPath(
        'id:wt-1',
        'old.ts',
        'new.ts',
        undefined,
        'ssh-1',
        'ssh:ssh-1'
      )
    ).rejects.toThrow('SSH connection changed')
    expect(renameNoClobber).not.toHaveBeenCalled()
  })

  it('rejects an equal-generation mutation captured for another SSH target', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ renameNoClobber } as never)
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-b' })

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', 0, 'ssh-a', 'ssh:ssh-a')
    ).rejects.toThrow('Workspace host changed')
    expect(getSshFilesystemProvider).not.toHaveBeenCalled()
    expect(renameNoClobber).not.toHaveBeenCalled()
  })

  it('rejects a stale SSH expectation after the worktree becomes HUB-local', async () => {
    const { commands } = createRuntimeFileCommands()

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', 0, 'ssh-1', 'ssh:ssh-1')
    ).rejects.toThrow('Workspace host changed')
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('propagates runtime remote no-clobber rename failures', async () => {
    const renameNoClobber = vi.fn().mockRejectedValue(new Error('destination exists'))
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ renameNoClobber } as never)
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts', 0, 'ssh-1', 'ssh:ssh-1')
    ).rejects.toThrow('destination exists')
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('uses a conservative Node watcher for Windows runtime file watches', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> }
    watcher.close = vi.fn(() => queueMicrotask(() => watcher.emit('close')))
    let listener: (() => void) | null = null
    watchMock.mockImplementation((_rootPath, _options, callback) => {
      listener = callback
      return watcher
    })
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const { commands } = createRuntimeFileCommands({ path: 'C:\\repo' })
    const onEvents = vi.fn()

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', onEvents)

    expect(watchMock).toHaveBeenCalledWith('C:\\repo', { recursive: true }, expect.any(Function))
    const emit = listener as (() => void) | null
    expect(emit).not.toBeNull()

    emit?.()
    emit?.()
    await vi.advanceTimersByTimeAsync(149)
    expect(onEvents).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onEvents).toHaveBeenCalledTimes(1)
    expect(onEvents).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: 'C:\\repo' }])

    await unsubscribe()
    expect(watcher.close).toHaveBeenCalledTimes(1)
  })

  it('delegates local recursive watching to the watcher process', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux'
    })
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const dispose = vi.fn()
    watchInWatcherProcessMock.mockResolvedValue(dispose)
    const { commands } = createRuntimeFileCommands()

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', vi.fn())
    expect(watchInWatcherProcessMock).toHaveBeenCalledWith(
      '/repo',
      expect.any(Function),
      expect.any(Function),
      undefined
    )

    unsubscribe()
    await awaitRuntimeFileWatcherUnsubscribes()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('keeps SSH runtime watches on the remote filesystem provider', async () => {
    const remoteDispose = vi.fn()
    const providerWatch = vi.fn(() => remoteDispose)
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ watch: providerWatch } as never)
    const { commands, store } = createRuntimeFileCommands({ path: '/remote/repo' })
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
    const onEvents = vi.fn()

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', onEvents)

    expect(providerWatch).toHaveBeenCalledWith('/remote/repo', onEvents, {
      signal: undefined,
      onTerminalError: expect.any(Function)
    })
    expect(watchInWatcherProcessMock).not.toHaveBeenCalled()
    await unsubscribe()
    expect(remoteDispose).toHaveBeenCalledTimes(1)
  })

  it('indexes SSH runtime watches so remote deletion can await them', async () => {
    let resolveDispose: () => void = () => {}
    const remoteDispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDispose = resolve
        })
    )
    vi.mocked(getSshFilesystemProvider).mockReturnValue({
      watch: vi.fn(() => remoteDispose)
    } as never)
    const { commands, store } = createRuntimeFileCommands({ path: '/remote/repo' })
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
    await commands.watchFileExplorer('id:wt-1', vi.fn())

    let closed = false
    const close = commands.closeFileExplorerWatchersForPath('/remote/repo', 'ssh-1').then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(remoteDispose).toHaveBeenCalledTimes(1)
    expect(closed).toBe(false)

    resolveDispose()
    await close
  })

  it('scopes same-path runtime watcher teardown to its SSH execution host', async () => {
    const firstDispose = vi.fn()
    const secondDispose = vi.fn()
    vi.mocked(getSshFilesystemProvider).mockImplementation(
      (connectionId) =>
        ({
          watch: vi.fn(() => (connectionId === 'ssh-1' ? firstDispose : secondDispose))
        }) as never
    )
    const first = createRuntimeFileCommands({ path: '/same/repo' })
    const second = createRuntimeFileCommands({ path: '/same/repo' })
    first.store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
    second.store.getRepo.mockReturnValue({ connectionId: 'ssh-2' })

    await first.commands.watchFileExplorer('id:wt-1', vi.fn())
    await second.commands.watchFileExplorer('id:wt-1', vi.fn())
    await first.commands.closeFileExplorerWatchersForPath('/same/repo', 'ssh-1')

    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(secondDispose).not.toHaveBeenCalled()

    await second.commands.closeFileExplorerWatchersForPath('/same/repo', 'ssh-2')
    expect(secondDispose).toHaveBeenCalledTimes(1)
  })

  it('settles and detaches runtime rg searches when timeout kill is ignored', async () => {
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1',
        path: '/repo'
      },
      connectionId: null
    }))
    const { commands } = createRuntimeFileCommands({ resolveRuntimeFileTarget })
    const child = createRuntimeSearchChild()
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    checkRgAvailableMock.mockResolvedValue(true)
    wslAwareSpawnMock.mockReturnValue(child)

    const resultPromise = commands.searchRuntimeFiles('id:wt-1', {
      query: 'needle',
      maxResults: 10
    })
    await vi.advanceTimersByTimeAsync(SEARCH_TIMEOUT_MS)

    await expect(resultPromise).resolves.toMatchObject({
      files: [],
      totalMatches: 0,
      truncated: true
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(child.listenerCount('close')).toBe(0)
  })

  it('routes runtime rg searches through the registered WSL project runtime', async () => {
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1',
        path: 'C:\\repo'
      },
      connectionId: null
    }))
    const { commands, store } = createRuntimeFileCommands({ resolveRuntimeFileTarget })
    const child = createRuntimeSearchChild()
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    checkRgAvailableMock.mockResolvedValue(true)
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    wslAwareSpawnMock.mockReturnValue(child)

    const resultPromise = commands.searchRuntimeFiles('id:wt-1', {
      query: 'needle',
      maxResults: 10
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    child.emit('close')

    await expect(resultPromise).resolves.toMatchObject({ files: [] })
    expect(getLocalGitOptionsForRegisteredWorktreeMock).toHaveBeenCalledWith(
      store,
      'C:\\repo',
      'C:\\repo'
    )
    expect(checkRgAvailableMock).toHaveBeenCalledWith('C:\\repo', 'Ubuntu')
    expect(wslAwareSpawnMock).toHaveBeenCalledWith(
      'rg',
      expect.any(Array),
      expect.objectContaining({
        cwd: 'C:\\repo',
        wslDistro: 'Ubuntu'
      })
    )
  })

  describe('resolveTerminalPath', () => {
    let tempDirs: string[] = []

    afterEach(async () => {
      await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
      tempDirs = []
    })

    async function tempFile(name: string, content: string): Promise<string> {
      const dir = await mkdtemp(join(tmpdir(), 'orca-terminal-artifact-'))
      tempDirs.push(dir)
      const filePath = join(dir, name)
      await writeFile(filePath, content)
      return filePath
    }

    function absoluteFileTarget(result: {
      openTarget?: { kind: string; absolutePath?: string; grantId?: string }
    }): { absolutePath: string; grantId: string } {
      if (
        result.openTarget?.kind !== 'absolute-file' ||
        typeof result.openTarget.absolutePath !== 'string' ||
        typeof result.openTarget.grantId !== 'string'
      ) {
        throw new Error('Expected an absolute terminal artifact target')
      }
      return result.openTarget as { absolutePath: string; grantId: string }
    }

    function statAsFile() {
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 12, dev: 1, ino: 2, mtimeMs: 3 })
    }

    function resolveTerminalArtifactPath(
      commands: RuntimeFileCommands,
      pathText: string,
      cwd: string | null = null,
      clientId = 'client-a'
    ) {
      return commands.resolveTerminalPath('id:wt-1', pathText, cwd, clientId, 'term-1')
    }

    function createRemoteTerminalArtifactGrantFixture(artifactPath = '/tmp/result.json') {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      let realArtifactPath = artifactPath
      const stat = vi.fn().mockResolvedValue({ type: 'file', size: 11, mtime: 3 })
      const readTerminalArtifact = vi
        .fn()
        .mockResolvedValue({ content: '{"ok":true}', isBinary: false })
      const writeTerminalArtifact = vi.fn().mockResolvedValue({ type: 'file', size: 12, mtime: 4 })
      const realpath = vi.fn(async (p: string) => (p === artifactPath ? realArtifactPath : p))
      vi.mocked(getSshFilesystemProvider).mockReturnValue({
        stat,
        readTerminalArtifact,
        realpath,
        writeTerminalArtifact
      } as never)
      return {
        commands,
        readTerminalArtifact,
        writeTerminalArtifact,
        moveArtifactTarget: (nextPath: string) => {
          realArtifactPath = nextPath
        }
      }
    }

    it('resolves an absolute path inside the worktree to a relative path', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      statAsFile()

      const result = await commands.resolveTerminalPath('id:wt-1', '/repo/src/index.ts')

      expect(result).toEqual({
        worktree: 'wt-1',
        relativePath: 'src/index.ts',
        absolutePath: '/repo/src/index.ts',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'src/index.ts',
          absolutePath: '/repo/src/index.ts'
        }
      })
    })

    it('resolves a relative path against the provided cwd', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      statAsFile()

      const result = await commands.resolveTerminalPath('id:wt-1', 'index.ts', '/repo/src')

      expect(result).toMatchObject({ relativePath: 'src/index.ts', exists: true })
    })

    it('prefers the source terminal cwd over stale mobile cached cwd metadata', async () => {
      const resolveTerminalCwd = vi.fn(() => '/repo/current')
      const { commands } = createRuntimeFileCommands({ path: '/repo', resolveTerminalCwd })
      statAsFile()

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        'index.ts',
        '/repo/stale',
        'client-a',
        'term-1'
      )

      expect(resolveTerminalCwd).toHaveBeenCalledWith('term-1')
      expect(result).toMatchObject({ relativePath: 'current/index.ts', exists: true })
    })

    it('falls back to the source terminal cwd when mobile has not cached cwd metadata', async () => {
      const resolveTerminalCwd = vi.fn(() => '/repo/src')
      const { commands } = createRuntimeFileCommands({ path: '/repo', resolveTerminalCwd })
      statAsFile()

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        'index.ts',
        null,
        'client-a',
        'term-1'
      )

      expect(resolveTerminalCwd).toHaveBeenCalledWith('term-1')
      expect(result).toMatchObject({ relativePath: 'src/index.ts', exists: true })
    })

    it('awaits async source terminal cwd fallback from the PTY provider', async () => {
      const resolveTerminalCwd = vi.fn(async () => '/repo/packages/app')
      const { commands } = createRuntimeFileCommands({ path: '/repo', resolveTerminalCwd })
      statAsFile()

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        'package.json',
        null,
        'client-a',
        'term-1'
      )

      expect(result).toMatchObject({ relativePath: 'packages/app/package.json', exists: true })
    })

    it('resolves a relative path against the worktree root when no cwd is given', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      statAsFile()

      const result = await commands.resolveTerminalPath('id:wt-1', 'docs/readme.md')

      expect(result).toMatchObject({ relativePath: 'docs/readme.md', exists: true })
    })

    it('reports a directory', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => true })

      const result = await commands.resolveTerminalPath('id:wt-1', '/repo/src')

      expect(result).toMatchObject({ relativePath: 'src', isDirectory: true, exists: true })
    })

    it('returns an absolute open target for an existing local temp path outside the worktree', async () => {
      const artifactPath = await tempFile('result.json', '{}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 12, dev: 1, ino: 2, mtimeMs: 3 })
      const canonicalPath = await realpath(artifactPath)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)

      expect(result).toMatchObject({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: canonicalPath,
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'absolute-file',
          provider: 'local',
          absolutePath: canonicalPath
        }
      })
      expect(result.openTarget?.kind === 'absolute-file' ? result.openTarget.grantId : '').toMatch(
        /\S/
      )
      expect(resolveAuthorizedPathMock).not.toHaveBeenCalledWith(canonicalPath, expect.anything())
      expect(statMock).not.toHaveBeenCalled()
    })

    it('does not mint an absolute terminal artifact grant without a source terminal', async () => {
      const artifactPath = await tempFile('result.json', '{}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })

      const result = await commands.resolveTerminalPath('id:wt-1', artifactPath, null, 'client-a')

      expect(result).toMatchObject({
        worktree: 'wt-1',
        relativePath: null,
        exists: false,
        isDirectory: false
      })
      expect(result.openTarget).toBeUndefined()
    })

    it('does not mint an absolute terminal artifact grant for an unobserved path', async () => {
      const artifactPath = await tempFile('result.json', '{}')
      const hasRecentTerminalOutputPath = vi.fn(
        (_terminalHandle: string, _pathText: string, _absolutePath: string) => false
      )
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        hasRecentTerminalOutputPath
      })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)

      expect(result).toMatchObject({
        worktree: 'wt-1',
        relativePath: null,
        exists: false,
        isDirectory: false
      })
      expect(result.openTarget).toBeUndefined()
      expect(hasRecentTerminalOutputPath).toHaveBeenCalledTimes(1)
      const observed = hasRecentTerminalOutputPath.mock.calls[0]!
      expect(observed[0]).toBe('term-1')
      expect(observed[1]).toBe(artifactPath)
      expect(observed[2]).toContain('result.json')
      expect(observed[1]).toContain('result.json')
    })

    it('does not mint an absolute artifact grant from a relative path observed under stale cwd', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-terminal-artifact-'))
      tempDirs.push(dir)
      const artifactPath = join(dir, 'result.json')
      await writeFile(artifactPath, '{}')
      const hasRecentTerminalOutputPath = vi.fn(
        (_terminalHandle: string, pathText: string, _absolutePath: string) =>
          pathText === 'result.json'
      )
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        hasRecentTerminalOutputPath
      })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockRejectedValue(enoent())

      const result = await resolveTerminalArtifactPath(commands, 'result.json', dir)

      expect(result).toMatchObject({
        relativePath: 'result.json',
        absolutePath: '/repo/result.json',
        exists: false
      })
      expect(result.openTarget).toBeUndefined()
      expect(hasRecentTerminalOutputPath).not.toHaveBeenCalled()
    })

    it('does not mint an artifact grant from a terminal attached to a different worktree', async () => {
      const artifactPath = await tempFile('result.json', '{}')
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        resolveTerminalContext: vi.fn(() => ({ worktreeId: 'other-wt', connectionId: null }))
      })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)

      expect(result).toMatchObject({
        worktree: 'wt-1',
        relativePath: null,
        exists: false,
        isDirectory: false
      })
      expect(result.openTarget).toBeUndefined()
    })

    it('does not mint a local artifact grant from an SSH terminal handle', async () => {
      const artifactPath = await tempFile('result.json', '{}')
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        resolveTerminalContext: vi.fn(() => ({ worktreeId: 'wt-1', connectionId: 'ssh-1' }))
      })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)

      expect(result).toMatchObject({
        worktree: 'wt-1',
        relativePath: null,
        exists: false,
        isDirectory: false
      })
      expect(result.openTarget).toBeUndefined()
    })

    it('uses the canonical local temp artifact path for the exact grant', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-terminal-artifact-'))
      tempDirs.push(dir)
      const artifactPath = join(dir, 'result.json')
      const linkPath = join(dir, 'link-result.json')
      await writeFile(artifactPath, '{}')
      await symlink(artifactPath, linkPath)
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 2, dev: 1, ino: 2, mtimeMs: 3 })
      const canonicalPath = await realpath(artifactPath)

      const result = await resolveTerminalArtifactPath(commands, linkPath)

      expect(result).toMatchObject({
        relativePath: null,
        absolutePath: canonicalPath,
        exists: true,
        openTarget: {
          kind: 'absolute-file',
          provider: 'local',
          absolutePath: canonicalPath
        }
      })
      expect(resolveAuthorizedPathMock).not.toHaveBeenCalledWith(canonicalPath, expect.anything())
      expect(resolveAuthorizedPathMock).not.toHaveBeenCalledWith(linkPath, expect.anything())
    })

    it('does not grant hard-linked local temp artifacts', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-terminal-artifact-'))
      tempDirs.push(dir)
      const originalPath = join(dir, 'outside.json')
      const artifactPath = join(dir, 'result.json')
      await writeFile(originalPath, '{"secret":true}')
      await link(originalPath, artifactPath)
      const { commands } = createRuntimeFileCommands({ path: '/repo' })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)

      expect(result).toMatchObject({
        relativePath: null,
        absolutePath: artifactPath,
        exists: false
      })
      expect(result.openTarget).toBeUndefined()
    })

    it('does not grant arbitrary absolute local paths outside temp roots', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })

      const result = await commands.resolveTerminalPath('id:wt-1', '/etc/passwd', null, 'client-a')

      expect(result).toEqual({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/etc/passwd',
        exists: false,
        isDirectory: false
      })
      expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
      expect(statMock).not.toHaveBeenCalled()
    })

    it('uses the canonical remote temp artifact path for the exact grant', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi.fn().mockResolvedValue({ type: 'file', size: 2, mtime: 3 })
      const realpath = vi.fn(async (p: string) =>
        p === '/tmp/link-result.json' ? '/tmp/result.json' : p
      )
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat, realpath } as never)

      const result = await resolveTerminalArtifactPath(commands, '/tmp/link-result.json')

      expect(stat).toHaveBeenCalledWith('/tmp/result.json')
      expect(result).toMatchObject({
        relativePath: null,
        absolutePath: '/tmp/result.json',
        exists: true,
        openTarget: {
          kind: 'absolute-file',
          provider: 'ssh',
          absolutePath: '/tmp/result.json'
        }
      })
    })

    it('does not grant hard-linked remote temp artifacts', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi.fn().mockResolvedValue({ type: 'file', size: 2, mtime: 3, nlink: 2 })
      const realpath = vi.fn(async (p: string) => p)
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat, realpath } as never)

      const result = await resolveTerminalArtifactPath(commands, '/tmp/result.json')

      expect(result).toMatchObject({
        relativePath: null,
        absolutePath: '/tmp/result.json',
        exists: false
      })
      expect(result.openTarget).toBeUndefined()
    })

    it('allows canonical remote macOS private temp artifacts', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi.fn().mockResolvedValue({ type: 'file', size: 2, mtime: 3 })
      const realpath = vi.fn(async (p: string) => p)
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat, realpath } as never)

      const result = await resolveTerminalArtifactPath(commands, '/private/tmp/result.json')

      expect(stat).toHaveBeenCalledWith('/private/tmp/result.json')
      expect(result).toMatchObject({
        relativePath: null,
        absolutePath: '/private/tmp/result.json',
        exists: true,
        openTarget: {
          kind: 'absolute-file',
          provider: 'ssh',
          absolutePath: '/private/tmp/result.json'
        }
      })
    })

    it('does not grant remote temp artifacts that resolve outside allowed temp roots', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi.fn()
      const realpath = vi.fn(async (p: string) =>
        p === '/tmp/link-result.json' ? '/home/me/.ssh/config' : p
      )
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat, realpath } as never)

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        '/tmp/link-result.json',
        null,
        'client-a'
      )

      expect(result).toEqual({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/tmp/link-result.json',
        exists: false,
        isDirectory: false
      })
      expect(stat).not.toHaveBeenCalled()
    })

    it('translates WSL absolute in-worktree paths before checking containment', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const worktreePath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
      const expectedPath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\src\\index.ts'
      const { commands } = createRuntimeFileCommands({ path: worktreePath })
      statAsFile()

      const result = await commands.resolveTerminalPath('id:wt-1', '/home/me/repo/src/index.ts')

      expect(result).toMatchObject({
        relativePath: 'src/index.ts',
        absolutePath: expectedPath,
        exists: true,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'src/index.ts',
          absolutePath: expectedPath
        }
      })
      expect(resolveAuthorizedPathMock).toHaveBeenCalledWith(expectedPath, expect.anything())
    })

    it('does not translate UNC-style paths as WSL POSIX paths', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const worktreePath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
      const { commands } = createRuntimeFileCommands({ path: worktreePath })

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        '//remote-host/tmp/result.json',
        null,
        'client-a'
      )

      expect(result).toEqual({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '//remote-host/tmp/result.json',
        exists: false,
        isDirectory: false
      })
      expect(resolveAuthorizedPathMock).not.toHaveBeenCalled()
      expect(statMock).not.toHaveBeenCalled()
    })

    it('preserves UNC-style paths for local Windows terminal links', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const worktreePath = '\\\\server\\share\\repo'
      const expectedPath = '//server/share/repo/src/index.ts'
      const { commands } = createRuntimeFileCommands({ path: worktreePath })
      statAsFile()

      const result = await commands.resolveTerminalPath('id:wt-1', expectedPath)

      expect(result).toMatchObject({
        relativePath: 'src/index.ts',
        absolutePath: expectedPath,
        exists: true,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'src/index.ts',
          absolutePath: expectedPath
        }
      })
    })

    it('preserves local Windows UNC file URI authority even when OSC7 reported the host', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const worktreePath = '\\\\server\\share\\repo'
      const expectedPath = '//server/share/repo/src/index.ts'
      const resolveTerminalFileUriHostname = vi.fn(() => 'server')
      const { commands } = createRuntimeFileCommands({
        path: worktreePath,
        resolveTerminalFileUriHostname
      })
      statAsFile()

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        expectedPath,
        null,
        'client-a',
        'term-1'
      )

      expect(resolveTerminalFileUriHostname).toHaveBeenCalledWith('term-1')
      expect(result).toMatchObject({
        relativePath: 'src/index.ts',
        absolutePath: expectedPath,
        exists: true,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'src/index.ts',
          absolutePath: expectedPath
        }
      })
    })

    it('preserves host-qualified local POSIX terminal links from unverified OSC7 host metadata', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      const artifactPath = await tempFile('result.json', '{}')
      const resolveTerminalFileUriHostname = vi.fn(() => 'laptop.local')
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        resolveTerminalFileUriHostname
      })

      const result = await resolveTerminalArtifactPath(commands, `//laptop.local${artifactPath}`)

      expect(resolveTerminalFileUriHostname).toHaveBeenCalledWith('term-1')
      expect(result).toMatchObject({
        relativePath: null,
        absolutePath: `//laptop.local${artifactPath}`,
        exists: false
      })
      expect(result.openTarget).toBeUndefined()
    })

    it('opens IPv4 loopback local POSIX terminal links as local paths', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      const artifactPath = await tempFile('result.json', '{}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      const canonicalPath = await realpath(artifactPath)

      const result = await resolveTerminalArtifactPath(commands, `//127.0.0.1${artifactPath}`)

      expect(result).toMatchObject({
        relativePath: null,
        absolutePath: canonicalPath,
        exists: true,
        openTarget: {
          kind: 'absolute-file',
          provider: 'local',
          absolutePath: canonicalPath
        }
      })
    })

    it('opens host-qualified remote POSIX terminal links when the source terminal verified the host', async () => {
      const resolveTerminalFileUriHostname = vi.fn(() => 'remote-host')
      const hasRecentTerminalOutputPath = vi.fn(() => true)
      const { commands, store } = createRuntimeFileCommands({
        path: '/home/me/repo',
        resolveTerminalFileUriHostname,
        hasRecentTerminalOutputPath
      })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi.fn().mockResolvedValue({ type: 'file', size: 2, mtime: 3 })
      const realpath = vi.fn(async (p: string) => p)
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat, realpath } as never)

      const result = await resolveTerminalArtifactPath(commands, '//remote-host/tmp/result.json')

      expect(resolveTerminalFileUriHostname).toHaveBeenCalledWith('term-1')
      expect(hasRecentTerminalOutputPath).toHaveBeenCalledWith(
        'term-1',
        '//remote-host/tmp/result.json',
        '/tmp/result.json'
      )
      expect(stat).toHaveBeenCalledWith('/tmp/result.json')
      expect(result).toMatchObject({
        relativePath: null,
        absolutePath: '/tmp/result.json',
        exists: true,
        openTarget: {
          kind: 'absolute-file',
          provider: 'ssh',
          absolutePath: '/tmp/result.json'
        }
      })
    })

    it('opens host-qualified Windows SSH worktree file URLs with a drive path', async () => {
      const resolveTerminalFileUriHostname = vi.fn(() => 'remote-host')
      const { commands, store } = createRuntimeFileCommands({
        path: 'C:/Users/me/repo',
        resolveTerminalFileUriHostname
      })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi.fn().mockResolvedValue({ type: 'file', size: 2, mtime: 3 })
      const realpath = vi.fn(async (p: string) => p)
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat, realpath } as never)

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        '//remote-host/C:/Users/me/repo/src/app.ts',
        null,
        'client-a',
        'term-1'
      )

      expect(result).toMatchObject({
        relativePath: 'src/app.ts',
        absolutePath: 'C:/Users/me/repo/src/app.ts',
        exists: true,
        openTarget: {
          kind: 'worktree-file',
          provider: 'ssh',
          relativePath: 'src/app.ts',
          absolutePath: 'C:/Users/me/repo/src/app.ts'
        }
      })
    })

    it('rejects host-qualified remote POSIX terminal links without a verified host match', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/home/me/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi.fn().mockResolvedValue({ type: 'file', size: 2, mtime: 3 })
      const realpath = vi.fn(async (p: string) => p)
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat, realpath } as never)

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        '//remote-host/tmp/result.json',
        null,
        'client-a'
      )

      expect(stat).not.toHaveBeenCalled()
      expect(result).toEqual({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '//remote-host/tmp/result.json',
        exists: false,
        isDirectory: false
      })
    })

    it('translates WSL temp artifacts before granting the exact path', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const worktreePath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
      const artifactPath = '\\\\wsl.localhost\\Ubuntu\\tmp\\result.json'
      const { commands } = createRuntimeFileCommands({ path: worktreePath })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 2, dev: 1, ino: 2, mtimeMs: 3 })
      openMock.mockResolvedValue({
        stat: vi.fn(async () => ({
          isDirectory: () => false,
          size: 2,
          dev: 1,
          ino: 2,
          mtimeMs: 3
        })),
        close: vi.fn(async () => undefined)
      })

      const result = await resolveTerminalArtifactPath(commands, '/tmp/result.json')

      expect(result).toMatchObject({
        relativePath: null,
        absolutePath: artifactPath,
        exists: true,
        openTarget: {
          kind: 'absolute-file',
          provider: 'local',
          absolutePath: artifactPath
        }
      })
      expect(resolveAuthorizedPathMock).not.toHaveBeenCalledWith(artifactPath, expect.anything())
    })

    it('reads an absolute terminal artifact only for the client that received the grant', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 11, dev: 1, ino: 2, mtimeMs: 3 })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).resolves.toMatchObject({
        relativePath: target.absolutePath,
        content: '{"ok":true}',
        truncated: false
      })
      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-b'
        )
      ).rejects.toThrow('terminal_file_grant_mismatch')
    })

    it('revokes absolute terminal artifact grants when the owning client disconnects', async () => {
      const artifactPath = await tempFile('result.json', '{}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 2, dev: 1, ino: 2, mtimeMs: 3 })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)

      commands.revokeTerminalFileGrantsForClient('client-a')

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_expired')
    })

    it('expires absolute terminal artifact grants without waiting for another tap', async () => {
      const artifactPath = await tempFile('result.json', '{}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => false, size: 2, dev: 1, ino: 2, mtimeMs: 3 })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1)

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_expired')
      expect(statMock).not.toHaveBeenCalled()
    })

    it('rejects stale absolute terminal artifact writes before changing the file', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)
      await rm(artifactPath)
      await writeFile(artifactPath, '{"ok":"ext"}')

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '{"ok":false}',
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('{"ok":"ext"}')
    })

    it('keeps the original terminal artifact when atomic commit fails', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      renameMock.mockRejectedValueOnce(new Error('ENOSPC'))

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '{"ok":false}',
          'client-a'
        )
      ).rejects.toThrow('ENOSPC')
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('{"ok":true}')
    })

    it('rejects hard-linked terminal artifact writes after a grant is created', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const hardLinkPath = join(artifactPath, '..', 'linked-result.json')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)
      await link(artifactPath, hardLinkPath)

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '{"ok":false}',
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('{"ok":true}')
    })

    it('rejects stale absolute terminal artifact reads before returning changed content', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)

      await rm(artifactPath)
      await writeFile(artifactPath, '{"ok":false}')

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
    })

    it('rejects retargeted symlink terminal artifact reads before returning outside content', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const outsidePath = join(artifactPath, '..', 'outside.json')
      await writeFile(outsidePath, '{"secret":true}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)
      await rm(artifactPath)
      await symlink(outsidePath, artifactPath)

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
    })

    it('rejects retargeted symlink terminal artifact writes before changing outside content', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const outsidePath = join(artifactPath, '..', 'outside.json')
      await writeFile(outsidePath, '{"secret":true}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)
      await rm(artifactPath)
      await symlink(outsidePath, artifactPath)

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '{"ok":false}',
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      await expect(readFile(outsidePath, 'utf8')).resolves.toBe('{"secret":true}')
    })

    it('does not renew stale terminal artifact grants', async () => {
      const artifactPath = await tempFile('result.json', '{"ok":true}')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)
      await rm(artifactPath)
      await writeFile(artifactPath, '{"ok":false}')

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1)

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_expired')
    })

    it('rejects stale absolute terminal artifact previews before returning changed content', async () => {
      const artifactPath = await tempFile('result.png', 'fake-png')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)

      await rm(artifactPath)
      await writeFile(artifactPath, 'changed!')

      await expect(
        commands.readTerminalArtifactPreview(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
    })

    it('rejects binary-extension terminal artifacts from the editable text path', async () => {
      const artifactPath = await tempFile('report.pdf', '%PDF text-looking bytes')
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({
        isDirectory: () => false,
        size: 23,
        dev: 1,
        ino: 2,
        mtimeMs: 3
      })

      const result = await resolveTerminalArtifactPath(commands, artifactPath)
      const target = absoluteFileTarget(result)

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('binary_file')
      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'not a pdf',
          'client-a'
        )
      ).rejects.toThrow('binary_file')
      await expect(readFile(artifactPath, 'utf8')).resolves.toBe('%PDF text-looking bytes')
    })

    it('rejects remote binary terminal artifact writes before changing the file', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi
        .fn()
        .mockResolvedValue({ type: 'file', size: 4, mtimeMs: 3, isDirectory: () => false })
      const writeTerminalArtifact = vi.fn().mockRejectedValue(new Error('binary_file'))
      const realpath = vi.fn(async (p: string) => p)
      const writeFile = vi.fn()
      vi.mocked(getSshFilesystemProvider).mockReturnValue({
        stat,
        realpath,
        writeFile,
        writeTerminalArtifact
      } as never)

      const result = await resolveTerminalArtifactPath(commands, '/tmp/result.txt')
      const grantId = result.openTarget?.kind === 'absolute-file' ? result.openTarget.grantId : ''

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          grantId,
          '/tmp/result.txt',
          'not binary anymore',
          'client-a'
        )
      ).rejects.toThrow('binary_file')
      expect(writeFile).not.toHaveBeenCalled()
      expect(writeTerminalArtifact).toHaveBeenCalled()
    })

    it('rejects remote terminal artifact reads when a grant no longer resolves to the granted path', async () => {
      const { commands, readTerminalArtifact, moveArtifactTarget } =
        createRemoteTerminalArtifactGrantFixture()
      const result = await resolveTerminalArtifactPath(commands, '/tmp/result.json')
      const target = absoluteFileTarget(result)

      moveArtifactTarget('/home/me/.ssh/config')

      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      expect(readTerminalArtifact).not.toHaveBeenCalled()
    })

    it('rejects remote terminal artifact previews when a grant no longer resolves to the granted path', async () => {
      const { commands, readTerminalArtifact, moveArtifactTarget } =
        createRemoteTerminalArtifactGrantFixture('/tmp/result.png')
      const result = await resolveTerminalArtifactPath(commands, '/tmp/result.png')
      const target = absoluteFileTarget(result)

      moveArtifactTarget('/tmp/other.png')

      await expect(
        commands.readTerminalArtifactPreview(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      expect(readTerminalArtifact).not.toHaveBeenCalled()
    })

    it('rejects remote terminal artifact writes when a grant no longer resolves to the granted path', async () => {
      const { commands, readTerminalArtifact, writeTerminalArtifact, moveArtifactTarget } =
        createRemoteTerminalArtifactGrantFixture()
      const result = await resolveTerminalArtifactPath(commands, '/tmp/result.json')
      const target = absoluteFileTarget(result)

      moveArtifactTarget('/home/me/.ssh/config')

      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          '{"ok":false}',
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_stale')
      expect(readTerminalArtifact).not.toHaveBeenCalled()
      expect(writeTerminalArtifact).not.toHaveBeenCalled()
    })

    it('reports a nonexistent in-worktree path as not existing', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

      const result = await commands.resolveTerminalPath('id:wt-1', 'src/missing.ts')

      expect(result).toMatchObject({ relativePath: 'src/missing.ts', exists: false })
    })

    it('does not expand ~/ on a remote worktree (home is unknown)', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi.fn()
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat } as never)

      const result = await commands.resolveTerminalPath('id:wt-1', '~/notes.md')

      expect(result).toMatchObject({ relativePath: null, exists: false })
      expect(stat).not.toHaveBeenCalled()
    })

    it('reports a missing remote file as not existing', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi.fn().mockRejectedValue(new Error('ENOENT: no such file'))
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat } as never)

      const result = await commands.resolveTerminalPath('id:wt-1', 'src/missing.ts')

      expect(result).toMatchObject({ relativePath: 'src/missing.ts', exists: false })
    })

    it('rethrows a remote transport error instead of reporting not-found', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi.fn().mockRejectedValue(new Error('Remote connection dropped'))
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat } as never)

      await expect(commands.resolveTerminalPath('id:wt-1', 'src/x.ts')).rejects.toThrow(
        'Remote connection dropped'
      )
    })
  })
})
