import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'

const { copyFileMock, handleMock, lstatMock, realpathMock, renameMock } = vi.hoisted(() => ({
  copyFileMock: vi.fn(),
  handleMock: vi.fn(),
  lstatMock: vi.fn(),
  realpathMock: vi.fn(),
  renameMock: vi.fn()
}))
const handlers = new Map<string, (_event: unknown, args: unknown) => Promise<unknown>>()

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return {
    ...actual,
    copyFile: copyFileMock,
    lstat: lstatMock,
    realpath: realpathMock,
    rename: renameMock
  }
})

import { renameLocalPathSerializedByDestination } from './destination-serialized-local-rename'
import { registerFilesystemMutationHandlers } from './ipc/filesystem-mutations'
import { RuntimeFileCommands } from './runtime/orca-runtime-files'

const REPO_PATH = path.resolve('/workspace/repo')
const store = {
  getRepos: () => [
    { id: 'repo-1', path: REPO_PATH, displayName: 'repo', badgeColor: '#000', addedAt: 0 }
  ],
  getSettings: () => ({ workspaceDir: path.resolve('/workspace') })
}

function enoent(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

function mockStats(dev: number, ino: number) {
  return { dev, ino, isDirectory: () => false }
}

function createRuntimeCommands(): RuntimeFileCommands {
  return new RuntimeFileCommands({
    requireStore: () => store,
    resolveRuntimeFileTarget: async () => ({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: REPO_PATH },
      executionHostId: 'local'
    })
  } as never)
}

function createGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function reachNextMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('renameLocalPathSerializedByDestination', () => {
  beforeEach(() => {
    handlers.clear()
    copyFileMock.mockReset()
    handleMock.mockReset()
    lstatMock.mockReset()
    realpathMock.mockReset()
    renameMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: never) => {
      handlers.set(channel, handler)
    })
    lstatMock.mockRejectedValue(enoent())
    realpathMock.mockImplementation(async (filePath: string) => filePath)
    renameMock.mockResolvedValue(undefined)
    registerFilesystemMutationHandlers(store as never)
  })

  it('serializes exact Unicode aliases across IPC and runtime entry points', async () => {
    const ipcSource = path.join(REPO_PATH, 'ipc-source.md')
    const runtimeSource = path.join(REPO_PATH, 'runtime-source.md')
    const sharpSDestination = path.join(REPO_PATH, 'Straße.md')
    const expandedDestination = path.join(REPO_PATH, 'STRASSE.md')
    const firstRenameGate = createGate()
    let destinationExists = false
    lstatMock.mockImplementation(async (filePath: string) => {
      if (
        destinationExists &&
        (filePath === sharpSDestination || filePath === expandedDestination)
      ) {
        return mockStats(1, 30)
      }
      if (filePath === ipcSource) {
        return mockStats(1, 10)
      }
      if (filePath === runtimeSource) {
        return mockStats(1, 20)
      }
      throw enoent()
    })
    renameMock.mockImplementation(async () => {
      if (renameMock.mock.calls.length === 1) {
        await firstRenameGate.promise
      }
      destinationExists = true
    })

    const ipcRename = handlers.get('fs:rename')!(null, {
      oldPath: ipcSource,
      newPath: sharpSDestination
    })
    await vi.waitFor(() => expect(renameMock).toHaveBeenCalledTimes(1))
    const runtimeRename = createRuntimeCommands().renameFileExplorerPath(
      'id:wt-1',
      'runtime-source.md',
      'STRASSE.md',
      undefined,
      undefined,
      'local'
    )
    await reachNextMacrotask()
    const callsWhileFirstBlocked = renameMock.mock.calls.length
    firstRenameGate.release()
    const results = await Promise.allSettled([ipcRename, runtimeRename])

    expect(callsWhileFirstBlocked).toBe(1)
    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(renameMock).toHaveBeenCalledTimes(1)
  })

  it('releases an alias queue after the leading rename errors', async () => {
    const firstRenameGate = createGate()
    renameMock.mockImplementation(async () => {
      if (renameMock.mock.calls.length === 1) {
        await firstRenameGate.promise
        throw new Error('EACCES')
      }
    })
    const destination = path.join(REPO_PATH, 'destination.md')

    const firstRename = renameLocalPathSerializedByDestination(
      path.join(REPO_PATH, 'first.md'),
      destination
    )
    await vi.waitFor(() => expect(renameMock).toHaveBeenCalledTimes(1))
    const secondRename = renameLocalPathSerializedByDestination(
      path.join(REPO_PATH, 'second.md'),
      destination
    )
    await reachNextMacrotask()
    expect(renameMock).toHaveBeenCalledTimes(1)

    firstRenameGate.release()
    await expect(firstRename).rejects.toThrow('EACCES')
    await expect(secondRename).resolves.toBeUndefined()
    expect(renameMock).toHaveBeenCalledTimes(2)
  })

  it('does not serialize destinations in unrelated parent directories', async () => {
    const firstRenameGate = createGate()
    renameMock.mockImplementation(async () => {
      if (renameMock.mock.calls.length === 1) {
        await firstRenameGate.promise
      }
    })

    const firstRename = renameLocalPathSerializedByDestination(
      path.join(REPO_PATH, 'first', 'source.md'),
      path.join(REPO_PATH, 'first', 'alpha.md')
    )
    await vi.waitFor(() => expect(renameMock).toHaveBeenCalledTimes(1))
    const secondRename = renameLocalPathSerializedByDestination(
      path.join(REPO_PATH, 'second', 'source.md'),
      path.join(REPO_PATH, 'second', 'beta.md')
    )
    await vi.waitFor(() => expect(renameMock).toHaveBeenCalledTimes(2))

    firstRenameGate.release()
    await expect(Promise.all([firstRename, secondRename])).resolves.toEqual([undefined, undefined])
  })

  it('serializes symlink aliases of one destination parent', async () => {
    const firstRenameGate = createGate()
    renameMock.mockImplementation(async () => {
      if (renameMock.mock.calls.length === 1) {
        await firstRenameGate.promise
      }
    })
    const firstParent = path.join(REPO_PATH, 'parent-link-a')
    const secondParent = path.join(REPO_PATH, 'parent-link-b')
    const canonicalParent = path.join(REPO_PATH, 'canonical-parent')
    realpathMock.mockImplementation(async (filePath: string) => {
      if (filePath === firstParent || filePath === secondParent) {
        return canonicalParent
      }
      return filePath
    })

    const firstRename = renameLocalPathSerializedByDestination(
      path.join(firstParent, 'source.md'),
      path.join(firstParent, 'alpha.md')
    )
    await vi.waitFor(() => expect(renameMock).toHaveBeenCalledTimes(1))
    const secondRename = renameLocalPathSerializedByDestination(
      path.join(secondParent, 'source.md'),
      path.join(secondParent, 'beta.md')
    )
    await reachNextMacrotask()
    expect(renameMock).toHaveBeenCalledTimes(1)

    firstRenameGate.release()
    await expect(Promise.all([firstRename, secondRename])).resolves.toEqual([undefined, undefined])
    expect(renameMock).toHaveBeenCalledTimes(2)
  })

  it('scopes conservative serialization to one destination parent', async () => {
    const firstRenameGate = createGate()
    renameMock.mockImplementation(async () => {
      if (renameMock.mock.calls.length === 1) {
        await firstRenameGate.promise
      }
    })

    const firstRename = renameLocalPathSerializedByDestination(
      path.join(REPO_PATH, 'first.md'),
      path.join(REPO_PATH, 'dotless-ı.md')
    )
    await vi.waitFor(() => expect(renameMock).toHaveBeenCalledTimes(1))
    const secondRename = renameLocalPathSerializedByDestination(
      path.join(REPO_PATH, 'second.md'),
      path.join(REPO_PATH, 'dotless-I.md')
    )
    await reachNextMacrotask()
    expect(renameMock).toHaveBeenCalledTimes(1)

    firstRenameGate.release()
    await expect(Promise.all([firstRename, secondRename])).resolves.toEqual([undefined, undefined])
    expect(renameMock).toHaveBeenCalledTimes(2)
  })
})
