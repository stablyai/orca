// Mock state for the RuntimeFileCommands suites. Kept free of imports from the
// module under test so `vi.mock` factories can load it without re-entering `fs`.
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type * as Fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import type * as FilesystemAuth from '../ipc/filesystem-auth'
import type * as GitRunner from '../git/runner'

// Mock signatures stay loose on payloads: suites assert call arguments and stub
// resolved values, so real fs/git result types would only fight the fixtures.
type WatchCallback = (...args: unknown[]) => void

export const lstatMock: Mock<(path: string) => Promise<unknown>> = vi.fn()
export const openMock: Mock<(...args: Parameters<typeof FsPromises.open>) => Promise<unknown>> =
  vi.fn()
export const readdirMock: Mock<(path: string, options?: unknown) => Promise<unknown>> = vi.fn()
export const renameMock: Mock<(from: string, to: string) => Promise<unknown>> = vi.fn()
export const resolveAuthorizedPathMock: Mock<
  (targetPath: string, store?: unknown, options?: unknown) => Promise<unknown>
> = vi.fn()
export const statMock: Mock<(path: string) => Promise<unknown>> = vi.fn()
export const watchInWatcherProcessMock: Mock<
  (
    rootPath: string,
    onEvents: WatchCallback,
    onError?: WatchCallback,
    signal?: AbortSignal
  ) => Promise<unknown>
> = vi.fn()
export const closeWatcherInWatcherProcessMock: Mock<(rootPath: string) => Promise<unknown>> =
  vi.fn()
export const checkRgAvailableMock: Mock<
  (searchPath?: string, wslDistro?: string) => Promise<unknown>
> = vi.fn()
export const getLocalGitOptionsForRegisteredWorktreeMock: Mock<
  (store: unknown, worktreePath: string, repoPath?: string) => unknown
> = vi.fn()
export const searchWithGitGrepMock: Mock<(...args: unknown[]) => Promise<unknown>> = vi.fn()
export const wslAwareSpawnMock: Mock<
  (command: string, args: string[], options: unknown) => unknown
> = vi.fn()
export const watchMock: Mock<
  (rootPath: string, options: unknown, callback: WatchCallback) => unknown
> = vi.fn()
export const getSshFilesystemProviderMock: Mock<(...args: unknown[]) => unknown> = vi.fn()

export function enoent(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

export async function fsModuleMock() {
  const actual = await vi.importActual<typeof Fs>('fs')
  return {
    ...actual,
    watch: watchMock
  }
}

export async function fsPromisesModuleMock() {
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
}

export const fileWatcherHostMock = {
  closeFileExplorerWatcherInWatcherProcess: closeWatcherInWatcherProcessMock,
  watchFileExplorerInWatcherProcess: watchInWatcherProcessMock
}

export async function filesystemAuthModuleMock() {
  const actual = await vi.importActual<typeof FilesystemAuth>('../ipc/filesystem-auth')
  return {
    ...actual,
    resolveAuthorizedPath: resolveAuthorizedPathMock
  }
}

export async function gitRunnerModuleMock() {
  const actual = await vi.importActual<typeof GitRunner>('../git/runner')
  return {
    ...actual,
    wslAwareSpawn: wslAwareSpawnMock
  }
}

export const rgAvailabilityMock = {
  checkRgAvailable: checkRgAvailableMock
}

export const localWorktreeRuntimeOptionsMock = {
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock
}

export const filesystemSearchGitMock = {
  searchWithGitGrep: searchWithGitGrepMock
}

const SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE =
  'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

export const sshFilesystemDispatchMock = {
  getSshFilesystemProvider: getSshFilesystemProviderMock,
  requireSshFilesystemProvider: (connectionId: string) => {
    const provider = getSshFilesystemProviderMock(connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    return provider
  },
  onSshFilesystemProviderRegistered: () => () => undefined,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
}

export function resetRuntimeFileMocks(): void {
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
  searchWithGitGrepMock.mockReset()
  getSshFilesystemProviderMock.mockReset()
  getLocalGitOptionsForRegisteredWorktreeMock.mockReset()
  wslAwareSpawnMock.mockReset()
  getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({})
  readdirMock.mockResolvedValue([])
  lstatMock.mockRejectedValue(enoent())
  renameMock.mockResolvedValue(undefined)
}
