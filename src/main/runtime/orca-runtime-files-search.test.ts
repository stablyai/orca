import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import {
  checkRgAvailableMock,
  getLocalGitOptionsForRegisteredWorktreeMock,
  getSshFilesystemProviderMock,
  resolveAuthorizedPathMock,
  searchWithGitGrepMock,
  wslAwareSpawnMock
} from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import { SEARCH_TIMEOUT_MS } from '../../shared/text-search'

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

type MockRuntimeSearchChild = EventEmitter & {
  stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

function createRuntimeSearchChild(): MockRuntimeSearchChild {
  const child = new EventEmitter() as MockRuntimeSearchChild
  child.stdout = new EventEmitter() as MockRuntimeSearchChild['stdout']
  child.stdout.setEncoding = vi.fn()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

async function flushRuntimeSearchMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve()
  }
}

describe('RuntimeFileCommands', () => {
  useRuntimeFileCommandsLifecycle()

  it('keeps byte-budgeted legacy listings count-bounded across an SSH hop', async () => {
    const listFiles = vi.fn().mockResolvedValue(['src/index.ts'])
    getSshFilesystemProviderMock.mockReturnValue({ listFiles })
    const { commands } = createRuntimeFileCommands({
      resolveRuntimeFileTarget: vi.fn(async () => ({
        worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo' },
        executionHostId: 'ssh:ssh-1'
      }))
    })

    await expect(commands.listRuntimeFiles('id:wt-1', { maxContentBytes: 1024 })).resolves.toEqual([
      'src/index.ts'
    ])
    expect(listFiles).toHaveBeenCalledWith('/repo', {
      excludePaths: undefined,
      maxResults: 20_001,
      signal: undefined
    })
  })

  it('settles and detaches runtime rg searches when timeout kill is ignored', async () => {
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1',
        path: '/repo'
      },
      executionHostId: 'local'
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
    expect(checkRgAvailableMock).not.toHaveBeenCalled()
  })

  it.each(['error-first', 'close-first'] as const)(
    'falls back once when runtime rg native launch failure is %s',
    async (order) => {
      const resolveRuntimeFileTarget = vi.fn(async () => ({
        worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo' },
        executionHostId: 'local'
      }))
      const { commands } = createRuntimeFileCommands({ resolveRuntimeFileTarget })
      const child = createRuntimeSearchChild()
      Object.defineProperty(child, 'pid', { value: undefined })
      resolveAuthorizedPathMock.mockResolvedValue('/repo')
      wslAwareSpawnMock.mockReturnValue(child)
      const fallback = { files: [], totalMatches: 0, truncated: false }
      searchWithGitGrepMock.mockResolvedValue(fallback)

      const resultPromise = commands.searchRuntimeFiles('id:wt-1', {
        query: 'needle',
        maxResults: 10
      })
      await flushRuntimeSearchMicrotasks()
      const error = Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' })
      if (order === 'error-first') {
        expect(() => child.emit('error', error)).not.toThrow()
        child.emit('close', -2, null)
      } else {
        child.emit('close', -2, null)
        expect(() => child.emit('error', error)).not.toThrow()
      }

      await expect(resultPromise).resolves.toBe(fallback)
      expect(searchWithGitGrepMock).toHaveBeenCalledTimes(1)
      expect(checkRgAvailableMock).not.toHaveBeenCalled()
      expect(child.listenerCount('error')).toBe(0)
      expect(child.listenerCount('close')).toBe(0)
    }
  )

  it("falls back when a runtime native launcher exits outside ripgrep's contract", async () => {
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo' },
      executionHostId: 'local'
    }))
    const { commands } = createRuntimeFileCommands({ resolveRuntimeFileTarget })
    const child = createRuntimeSearchChild()
    Object.defineProperty(child, 'pid', { value: 1 })
    resolveAuthorizedPathMock.mockResolvedValue('/repo')
    wslAwareSpawnMock.mockReturnValue(child)
    const fallback = { files: [], totalMatches: 0, truncated: false }
    searchWithGitGrepMock.mockResolvedValue(fallback)

    const resultPromise = commands.searchRuntimeFiles('id:wt-1', {
      query: 'needle',
      maxResults: 10
    })
    await flushRuntimeSearchMicrotasks()
    child.emit('close', 127, null)

    await expect(resultPromise).resolves.toBe(fallback)
    expect(searchWithGitGrepMock).toHaveBeenCalledTimes(1)
  })

  it('routes runtime rg searches through the registered WSL project runtime', async () => {
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: {
        id: 'wt-1',
        repoId: 'repo-1',
        path: 'C:\\repo'
      },
      executionHostId: 'local'
    }))
    const { commands, store } = createRuntimeFileCommands({ resolveRuntimeFileTarget })
    const child = createRuntimeSearchChild()
    Object.defineProperty(child, 'pid', { value: 1 })
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
    child.emit('close', 127, null)

    await expect(resultPromise).resolves.toMatchObject({ files: [] })
    expect(getLocalGitOptionsForRegisteredWorktreeMock).toHaveBeenCalledWith(
      store,
      'C:\\repo',
      'C:\\repo'
    )
    expect(checkRgAvailableMock).toHaveBeenCalledWith('C:\\repo', 'Ubuntu')
    expect(searchWithGitGrepMock).not.toHaveBeenCalled()
    expect(wslAwareSpawnMock).toHaveBeenCalledWith(
      'rg',
      expect.any(Array),
      expect.objectContaining({
        cwd: 'C:\\repo',
        wslDistro: 'Ubuntu'
      })
    )
  })

  it('keeps the runtime WSL preflight and falls back before starting real rg', async () => {
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: 'C:\\repo' },
      executionHostId: 'local'
    }))
    const { commands } = createRuntimeFileCommands({ resolveRuntimeFileTarget })
    const fallback = { files: [], totalMatches: 0, truncated: false }
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({ wslDistro: 'Ubuntu' })
    checkRgAvailableMock.mockResolvedValue(false)
    searchWithGitGrepMock.mockResolvedValue(fallback)

    await expect(
      commands.searchRuntimeFiles('id:wt-1', { query: 'needle', maxResults: 10 })
    ).resolves.toBe(fallback)
    expect(checkRgAvailableMock).toHaveBeenCalledWith('C:\\repo', 'Ubuntu')
    expect(wslAwareSpawnMock).not.toHaveBeenCalled()
  })

  it('keeps legacy SSH Quick Open replies within the frame-sized result bound', async () => {
    const resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo' },
      executionHostId: 'ssh:ssh-1'
    }))
    const { commands } = createRuntimeFileCommands({ resolveRuntimeFileTarget })
    const listFiles = vi.fn(async () => ['src/target.ts'])
    getSshFilesystemProviderMock.mockReturnValue({
      supportsQuickOpenSearch: vi.fn(async () => false),
      listFiles
    })

    await expect(commands.searchQuickOpenFilePaths('id:wt-1', 'target', 32)).resolves.toMatchObject(
      {
        files: [{ relativePath: 'src/target.ts' }],
        totalCount: 1,
        truncated: false
      }
    )
    expect(listFiles).toHaveBeenCalledWith('/repo', {
      excludePaths: undefined,
      maxResults: 32,
      signal: undefined
    })
  })
})
