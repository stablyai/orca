/* eslint-disable max-lines -- Why: runtime file command tests share mocked fs,
   authorization, and watcher lifecycle fixtures; splitting would duplicate the
   setup that makes cross-command filesystem behavior comparable. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type * as Fs from 'fs'
import type * as FsPromises from 'fs/promises'
import type * as FilesystemAuth from '../ipc/filesystem-auth'
import type * as GitRunner from '../git/runner'

const {
  lstatMock,
  readdirMock,
  renameMock,
  resolveAuthorizedPathMock,
  statMock,
  watchInWorkerMock,
  checkRgAvailableMock,
  wslAwareSpawnMock,
  watchMock
} = vi.hoisted(() => ({
  checkRgAvailableMock: vi.fn(),
  lstatMock: vi.fn(),
  readdirMock: vi.fn(),
  renameMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  statMock: vi.fn(),
  watchInWorkerMock: vi.fn(),
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
    readdir: readdirMock,
    rename: renameMock,
    stat: statMock
  }
})

vi.mock('./file-watcher-host', () => ({
  watchFileExplorerInWorker: watchInWorkerMock
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

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn(),
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE:
    'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
}))

import { awaitRuntimeFileWatcherUnsubscribes, RuntimeFileCommands } from './orca-runtime-files'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
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
  resolveRuntimeGitTarget?: ReturnType<typeof vi.fn>
}) {
  const store = {
    getRepo: vi.fn((_repoId?: string) => undefined as { connectionId?: string } | undefined)
  }
  const path = options?.path ?? '/repo'
  const commands = new RuntimeFileCommands({
    getRuntimeId: () => 'runtime-1',
    requireStore: () => store,
    resolveWorktreeSelector: vi.fn(async () => ({
      id: 'wt-1',
      repoId: 'repo-1',
      path
    })),
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
    readdirMock.mockReset()
    renameMock.mockReset()
    resolveAuthorizedPathMock.mockReset()
    statMock.mockReset()
    watchInWorkerMock.mockReset()
    watchMock.mockReset()
    checkRgAvailableMock.mockReset()
    wslAwareSpawnMock.mockReset()
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

    await commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts')

    expect(renameMock).toHaveBeenCalledWith('/repo/old.ts', '/repo/new.ts')
  })

  it('allows runtime-local case-only rename with IPC parity guard behavior', async () => {
    const { commands } = createRuntimeFileCommands()
    mockLocalPathStats({
      '/repo/README.md': [10, 100],
      '/repo/readme.md': [10, 100]
    })

    await commands.renameFileExplorerPath('id:wt-1', 'README.md', 'readme.md')

    expect(renameMock).toHaveBeenCalledWith('/repo/README.md', '/repo/readme.md')
  })

  it('rejects runtime-local true destination collisions', async () => {
    const { commands } = createRuntimeFileCommands()
    mockLocalPathStats({
      '/repo/old.ts': [11, 110],
      '/repo/new.ts': [11, 111]
    })

    await expect(commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts')).rejects.toThrow(
      "A file or folder named 'new.ts' already exists in this location"
    )

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('rejects runtime-local hard-link alias collisions', async () => {
    const { commands } = createRuntimeFileCommands()
    mockLocalPathStats({
      '/repo/README.md': [12, 120],
      '/repo/README-hardlink.md': [12, 120]
    })

    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'README.md', 'README-hardlink.md')
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
      commands.renameFileExplorerPath('id:wt-1', 'src/README.md', 'docs/readme.md')
    ).rejects.toThrow("A file or folder named 'readme.md' already exists in this location")

    expect(renameMock).not.toHaveBeenCalled()
  })

  it('routes runtime remote rename through the SSH no-clobber provider method', async () => {
    const renameNoClobber = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ renameNoClobber } as never)
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts')

    expect(renameNoClobber).toHaveBeenCalledWith('/repo/old.ts', '/repo/new.ts')
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('propagates runtime remote no-clobber rename failures', async () => {
    const renameNoClobber = vi.fn().mockRejectedValue(new Error('destination exists'))
    vi.mocked(getSshFilesystemProvider).mockReturnValue({ renameNoClobber } as never)
    const { commands, store } = createRuntimeFileCommands()
    store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

    await expect(commands.renameFileExplorerPath('id:wt-1', 'old.ts', 'new.ts')).rejects.toThrow(
      'destination exists'
    )
    expect(renameMock).not.toHaveBeenCalled()
  })

  it('uses a conservative Node watcher for Windows runtime file watches', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const close = vi.fn()
    const on = vi.fn()
    let listener: (() => void) | null = null
    watchMock.mockImplementation((_rootPath, _options, callback) => {
      listener = callback
      return { close, on }
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

    unsubscribe()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('delegates local recursive watching to the worker thread', async () => {
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    statMock.mockResolvedValue({ isDirectory: () => true })
    const dispose = vi.fn()
    watchInWorkerMock.mockResolvedValue(dispose)
    const { commands } = createRuntimeFileCommands()

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', vi.fn())
    expect(watchInWorkerMock).toHaveBeenCalledWith('/repo', expect.any(Function))

    unsubscribe()
    await awaitRuntimeFileWatcherUnsubscribes()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('settles and detaches runtime rg searches when timeout kill is ignored', async () => {
    const resolveRuntimeGitTarget = vi.fn(async () => ({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1',
        path: '/repo'
      },
      connectionId: null
    }))
    const { commands } = createRuntimeFileCommands({ resolveRuntimeGitTarget })
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
})
