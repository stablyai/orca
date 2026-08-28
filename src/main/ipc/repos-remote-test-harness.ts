import { EventEmitter } from 'node:events'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type * as GitRunner from '../git/runner'
import type * as RepoModule from '../git/repo'

/** Unconstrained spy; annotated explicitly so declaration emit never names @vitest/spy internals. */
export type ReposIpcSpy = Mock<(...args: never[]) => unknown>

/** Spy for git invocations whose recorded calls suites destructure positionally. */
export type ReposGitArgvSpy = Mock<(argv: string[], cwd?: string, options?: unknown) => unknown>

export type ReposIpcMocks = {
  handleMock: ReposIpcSpy
  mockStore: Record<
    | 'getRepos'
    | 'addRepo'
    | 'removeProject'
    | 'getRepo'
    | 'getProjects'
    | 'getProjectHostSetups'
    | 'updateProjectHostSetup'
    | 'getProjectGroups'
    | 'createProjectGroup'
    | 'updateProjectGroup'
    | 'deleteProjectGroup'
    | 'moveProjectToGroup'
    | 'getSshTarget',
    ReposIpcSpy
  > & { updateRepo: Mock<(repoId: string, updates: Record<string, unknown>) => unknown> }
  mockGitProvider: Record<
    'isGitRepo' | 'isGitRepoAsync' | 'clone' | 'listWorktrees' | 'getHostPlatform',
    ReposIpcSpy
  > & { exec: ReposGitArgvSpy }
  mockFilesystemProvider: Record<
    'readDir' | 'readFile' | 'stat' | 'createDir' | 'createDirNoClobber' | 'deletePath',
    ReposIpcSpy
  >
  mockMultiplexer: Record<'request' | 'notify', ReposIpcSpy>
  gitSpawnMock: ReposIpcSpy
  gitSpawnAfterWindowsEnvironmentReadyMock: ReposIpcSpy
  gitExecFileAsyncMock: ReposGitArgvSpy
  listWorktreeGraphMock: ReposIpcSpy
  invalidateAuthorizedRootsCacheMock: ReposIpcSpy
  prepareLocalWorktreeRootForRepoMock: ReposIpcSpy
}

export function createReposIpcMocks(): ReposIpcMocks {
  return {
    handleMock: vi.fn(),
    mockStore: {
      getRepos: vi.fn().mockReturnValue([]),
      addRepo: vi.fn(),
      removeProject: vi.fn(),
      getRepo: vi.fn(),
      updateRepo: vi.fn(),
      getProjects: vi.fn().mockReturnValue([]),
      getProjectHostSetups: vi.fn().mockReturnValue([]),
      updateProjectHostSetup: vi.fn(),
      getProjectGroups: vi.fn().mockReturnValue([]),
      createProjectGroup: vi.fn(),
      updateProjectGroup: vi.fn(),
      deleteProjectGroup: vi.fn(),
      moveProjectToGroup: vi.fn(),
      getSshTarget: vi.fn()
    },
    mockGitProvider: {
      isGitRepo: vi.fn().mockReturnValue(true),
      isGitRepoAsync: vi.fn().mockResolvedValue({ isRepo: true, rootPath: null }),
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      clone: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      listWorktrees: vi.fn().mockResolvedValue([]),
      getHostPlatform: vi.fn().mockReturnValue({
        relayPlatform: 'linux-x64',
        os: 'linux',
        arch: 'x64',
        pathFlavor: 'posix',
        commandDialect: 'posix',
        pathSeparator: '/',
        pathDelimiter: ':'
      })
    },
    mockFilesystemProvider: {
      readDir: vi.fn().mockResolvedValue([]),
      readFile: vi.fn().mockRejectedValue(new Error('not found')),
      stat: vi.fn().mockRejectedValue(new Error('not found')),
      createDir: vi.fn().mockResolvedValue(undefined),
      createDirNoClobber: vi.fn().mockResolvedValue(undefined),
      deletePath: vi.fn().mockResolvedValue(undefined)
    },
    mockMultiplexer: {
      request: vi.fn(),
      notify: vi.fn()
    },
    gitSpawnMock: vi.fn(),
    gitSpawnAfterWindowsEnvironmentReadyMock: vi.fn(),
    gitExecFileAsyncMock: vi.fn(),
    listWorktreeGraphMock: vi.fn(),
    invalidateAuthorizedRootsCacheMock: vi.fn(),
    prepareLocalWorktreeRootForRepoMock: vi.fn()
  }
}

export function electronModuleMock(mocks: ReposIpcMocks): Record<string, unknown> {
  return {
    dialog: { showOpenDialog: vi.fn() },
    ipcMain: {
      handle: mocks.handleMock,
      removeHandler: vi.fn()
    }
  }
}

// Why: use real pure helpers so SSH parity tests catch drift in DEFAULT_BASE_REF_PROBES / normalizeRefSearchQuery.
export function gitRepoModuleMock(actual: typeof RepoModule): Record<string, unknown> {
  return {
    ...actual,
    // Stub only the functions that spawn git / touch the filesystem.
    isGitRepo: vi.fn().mockReturnValue(true),
    getGitRepoRoot: vi.fn((path: string) => path),
    getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop()),
    getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
    getRemoteCount: vi.fn().mockResolvedValue(1),
    searchBaseRefs: vi.fn().mockResolvedValue([])
  }
}

// Why: keep the real env builders so the clone regression test (#7652) asserts real markers, not a mock echoing itself.
export function gitRunnerModuleMock(
  mocks: ReposIpcMocks,
  actual: typeof GitRunner
): Record<string, unknown> {
  return {
    ...actual,
    gitExecFileAsync: mocks.gitExecFileAsyncMock,
    gitExecFileAsyncBuffer: vi.fn(),
    gitStreamStdout: vi.fn(),
    gitSpawn: mocks.gitSpawnMock,
    gitSpawnAfterWindowsEnvironmentReady: mocks.gitSpawnAfterWindowsEnvironmentReadyMock
  }
}

export function gitWorktreeModuleMock(mocks: ReposIpcMocks): Record<string, unknown> {
  return { listWorktreeGraph: mocks.listWorktreeGraphMock }
}

export function registeredWorktreeRootsCacheModuleMock(
  mocks: ReposIpcMocks
): Record<string, unknown> {
  return { invalidateAuthorizedRootsCache: mocks.invalidateAuthorizedRootsCacheMock }
}

export function worktreeRootPreparationModuleMock(mocks: ReposIpcMocks): Record<string, unknown> {
  return { prepareLocalWorktreeRootForRepo: mocks.prepareLocalWorktreeRootForRepoMock }
}

export function sshGitDispatchModuleMock(mocks: ReposIpcMocks): Record<string, unknown> {
  return {
    getSshGitProviderGeneration: () => 0,
    getSshGitProvider: vi.fn().mockImplementation((id: string) => {
      if (id === 'conn-1') {
        return mocks.mockGitProvider
      }
      return undefined
    })
  }
}

export function sshFilesystemDispatchModuleMock(mocks: ReposIpcMocks): Record<string, unknown> {
  return {
    getSshFilesystemProvider: vi.fn().mockImplementation((id: string) => {
      if (id === 'conn-1') {
        return mocks.mockFilesystemProvider
      }
      return undefined
    })
  }
}

export function sshModuleMock(mocks: ReposIpcMocks): Record<string, unknown> {
  return {
    getActiveMultiplexer: vi.fn().mockImplementation((id: string) => {
      if (id === 'conn-1') {
        return mocks.mockMultiplexer
      }
      return undefined
    })
  }
}

export type RepoHandlerHarness = {
  handlers: Map<string, (_event: unknown, args: unknown) => unknown>
  mockWindow: { isDestroyed: () => boolean; webContents: { send: ReposIpcSpy } }
  captureHandlers: (handleMock: ReposIpcSpy) => void
}

/** Captures every `ipcMain.handle` registration so tests can invoke handlers directly. */
export function createRepoHandlerHarness(): RepoHandlerHarness {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
  const captureHandlers = (handleMock: ReposIpcMocks['handleMock']): void => {
    handlers.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
  return { handlers, mockWindow, captureHandlers }
}

/** Shared reset for the nested project-group scan/import handler suites. */
export function resetProjectGroupMocks(
  mocks: ReposIpcMocks,
  gitRepo: {
    isGitRepo: (path: string) => boolean
    getGitRepoRoot: (path: string) => string | null
  }
): void {
  mocks.mockStore.createProjectGroup.mockReset()
  mocks.mockStore.updateProjectGroup.mockReset()
  mocks.mockStore.deleteProjectGroup.mockReset()
  mocks.mockStore.moveProjectToGroup.mockReset()
  mocks.mockStore.addRepo.mockReset()
  mocks.mockStore.getProjects.mockReset().mockReturnValue([])
  mocks.mockStore.getProjectHostSetups.mockReset().mockReturnValue([])
  mocks.mockStore.updateProjectHostSetup.mockReset()
  mocks.mockStore.getRepos.mockReset()
  mocks.mockStore.getRepos.mockReturnValue([])
  mocks.mockFilesystemProvider.readDir.mockReset()
  mocks.mockFilesystemProvider.readDir.mockResolvedValue([])
  mocks.mockFilesystemProvider.readFile.mockReset()
  mocks.mockFilesystemProvider.readFile.mockRejectedValue(new Error('not found'))
  mocks.mockFilesystemProvider.stat.mockReset()
  mocks.mockFilesystemProvider.stat.mockRejectedValue(new Error('not found'))
  mocks.mockGitProvider.isGitRepoAsync.mockReset()
  mocks.mockGitProvider.isGitRepoAsync.mockResolvedValue({ isRepo: true, rootPath: null })
  mocks.mockGitProvider.listWorktrees.mockReset()
  mocks.mockGitProvider.listWorktrees.mockResolvedValue([])
  mocks.listWorktreeGraphMock.mockReset()
  mocks.listWorktreeGraphMock.mockResolvedValue([])
  vi.mocked(gitRepo.isGitRepo).mockReset()
  vi.mocked(gitRepo.isGitRepo).mockReturnValue(true)
  vi.mocked(gitRepo.getGitRepoRoot).mockReset()
  vi.mocked(gitRepo.getGitRepoRoot).mockImplementation((path: string) => path)
  mocks.mockMultiplexer.notify.mockReset()
  mocks.mockMultiplexer.request.mockReset()
  mocks.invalidateAuthorizedRootsCacheMock.mockReset()
  mocks.prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)
}

/** Shared reset for the local `repos:add` / `repos:clone` handler suites. */
export function resetLocalRepoMocks(mocks: ReposIpcMocks): void {
  mocks.mockStore.getRepos.mockReset().mockReturnValue([])
  mocks.mockStore.addRepo.mockReset()
  mocks.mockStore.updateRepo.mockReset()
  mocks.mockStore.getProjects.mockReset().mockReturnValue([])
  mocks.mockStore.getProjectHostSetups.mockReset().mockReturnValue([])
  mocks.mockStore.updateProjectHostSetup.mockReset()
  mocks.gitSpawnMock.mockReset()
  mocks.gitSpawnAfterWindowsEnvironmentReadyMock
    .mockReset()
    .mockImplementation(async (...args) => mocks.gitSpawnMock(...args))
  mocks.invalidateAuthorizedRootsCacheMock.mockReset()
  mocks.prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)
  mocks.gitSpawnMock.mockImplementation(() => {
    const proc = createMockCloneProcess()
    setImmediate(() => proc.emit('close', 0, null))
    return proc
  })
}

export type MockCloneProcess = EventEmitter & {
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

export function createMockCloneProcess(): MockCloneProcess {
  const proc = new EventEmitter() as MockCloneProcess
  proc.stderr = new EventEmitter()
  proc.kill = vi.fn().mockReturnValue(true)
  return proc
}

export async function waitForAssertion(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 2_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}
