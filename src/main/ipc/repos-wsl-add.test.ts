/**
 * Unit tests for the WSL add-project surface (Task 7 of WSL native project support).
 *
 * Pins the invariants that matter here:
 *   - `wsl:getDistroOptions({refresh:true})` re-probes, bypassing wsl.ts's sticky
 *     process-lifetime caches (the picker's "install WSL / add a distro" repair path).
 *   - Adding `{distro, linuxPath}` stores the modern `\\wsl.localhost\` UNC share,
 *     leaves the repo local (`connectionId` unset), and stamps the owning project's
 *     `localWindowsRuntimePreference = {kind:'wsl',distro}` — no new ExecutionHostId.
 *   - A legacy `\\wsl$\` prefix normalizes to `\\wsl.localhost\`, so repos differing
 *     only by that prefix dedup as one via `normalizeRuntimePathForComparison`.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Repo } from '../../shared/types'
import type * as WslModule from '../wsl'

const {
  handleMock,
  removeHandlerMock,
  mockStore,
  invalidateAuthorizedRootsCacheMock,
  prepareLocalWorktreeRootForRepoMock,
  listWslDistrosAsyncMock,
  isWslAvailableAsyncMock,
  wslUncDirectoryExistsAsyncMock,
  resolveWslGitRepoRootAsyncMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  mockStore: {
    getRepos: vi.fn(),
    addRepo: vi.fn(),
    getProjectHostSetups: vi.fn(),
    updateProject: vi.fn(),
    getRepo: vi.fn(),
    updateRepo: vi.fn()
  },
  invalidateAuthorizedRootsCacheMock: vi.fn(),
  prepareLocalWorktreeRootForRepoMock: vi.fn(),
  listWslDistrosAsyncMock: vi.fn(),
  isWslAvailableAsyncMock: vi.fn(),
  wslUncDirectoryExistsAsyncMock: vi.fn(),
  resolveWslGitRepoRootAsyncMock: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  access: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn()
}))

vi.mock('os', () => ({
  homedir: vi.fn().mockReturnValue('/Users/alice')
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(),
  gitSpawn: vi.fn()
}))

vi.mock('../git/repo', () => ({
  isGitRepo: vi.fn().mockReturnValue(true),
  getRepoName: vi.fn().mockImplementation((path: string) => path.split(/[\\/]/).at(-1)),
  getBaseRefDefault: vi.fn().mockResolvedValue('origin/main'),
  searchBaseRefs: vi.fn().mockResolvedValue([])
}))

vi.mock('./filesystem-auth', () => ({
  invalidateAuthorizedRootsCache: invalidateAuthorizedRootsCacheMock
}))

vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: prepareLocalWorktreeRootForRepoMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn()
}))

vi.mock('./ssh', () => ({
  getActiveMultiplexer: vi.fn()
}))

// Keep the real path helpers (toWindowsWslPath is pure); only the process-spawning
// probes are stubbed so tests never touch a live wsl.exe.
vi.mock('../wsl', async (importOriginal) => {
  const actual = await importOriginal<typeof WslModule>()
  return {
    ...actual,
    listWslDistrosAsync: listWslDistrosAsyncMock,
    isWslAvailableAsync: isWslAvailableAsyncMock,
    wslUncDirectoryExistsAsync: wslUncDirectoryExistsAsyncMock,
    resolveWslGitRepoRootAsync: resolveWslGitRepoRootAsyncMock
  }
})

import { registerRepoHandlers } from './repos'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { normalizeWslUncPrefix } from '../../shared/wsl-paths'

type AddArgs = {
  path?: string
  kind?: 'git' | 'folder'
  wsl?: { distro: string; linuxPath: string }
}
type AddResult = { repo: Repo } | { error: string }
type DistroOptions = { available: boolean; distros: string[]; default: string | null }

async function withWin32<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('WSL add-project IPC', () => {
  const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
  let repos: Repo[] = []

  const callAdd = (args: AddArgs): Promise<AddResult> => {
    const handler = handlers.get('repos:add')
    if (!handler) {
      throw new Error('repos:add handler was never registered')
    }
    return handler(null, args) as Promise<AddResult>
  }
  const callGetDistroOptions = (args: { refresh?: boolean }): Promise<DistroOptions> => {
    const handler = handlers.get('wsl:getDistroOptions')
    if (!handler) {
      throw new Error('wsl:getDistroOptions handler was never registered')
    }
    return Promise.resolve(handler(null, args)) as Promise<DistroOptions>
  }

  beforeEach(() => {
    handlers.clear()
    repos = []
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler as (event: unknown, args: unknown) => unknown)
    })
    removeHandlerMock.mockReset()

    mockStore.getRepos.mockReset().mockImplementation(() => repos)
    mockStore.addRepo.mockReset().mockImplementation((repo: Repo) => {
      repos.push(repo)
    })
    // A repo's owning project is derived from its projection; map repoId → a stable
    // projectId so the WSL branch can stamp the project's runtime preference.
    mockStore.getProjectHostSetups.mockReset().mockImplementation(() =>
      repos.map((repo) => ({
        id: repo.id,
        repoId: repo.id,
        projectId: `project::${repo.id}`,
        hostId: 'local',
        path: repo.path,
        displayName: repo.displayName,
        setupState: 'ready',
        setupMethod: 'imported-existing-folder',
        createdAt: 0,
        updatedAt: 0
      }))
    )
    mockStore.updateProject
      .mockReset()
      .mockImplementation((id: string, updates: unknown) => ({ id, ...(updates as object) }))
    mockStore.getRepo.mockReset()
    mockStore.updateRepo.mockReset()

    mockWindow.webContents.send.mockReset()
    invalidateAuthorizedRootsCacheMock.mockReset()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)

    listWslDistrosAsyncMock.mockReset()
    isWslAvailableAsyncMock.mockReset()
    wslUncDirectoryExistsAsyncMock.mockReset().mockResolvedValue(true)
    // Default: git-root resolution is inconclusive, so the raw picked path is kept.
    resolveWslGitRepoRootAsyncMock.mockReset().mockResolvedValue(null)

    registerRepoHandlers(mockWindow as never, mockStore as never)
  })

  // ── handler registration ──────────────────────────────────────────

  it('registers and pre-unregisters the wsl:getDistroOptions handler', () => {
    expect(handlers.has('wsl:getDistroOptions')).toBe(true)
    expect(removeHandlerMock).toHaveBeenCalledWith('wsl:getDistroOptions')
  })

  // ── wsl:getDistroOptions refresh ──────────────────────────────────

  it('re-probes distros on refresh, bypassing the sticky empty cache', async () => {
    isWslAvailableAsyncMock.mockResolvedValue(true)
    // Simulate wsl.ts's sticky cache: the first probe found nothing; a forced
    // refresh re-probes and discovers the distros.
    let sticky: string[] = []
    listWslDistrosAsyncMock.mockImplementation(async (opts?: { refresh?: boolean }) => {
      if (opts?.refresh) {
        sticky = ['Ubuntu', 'Debian']
      }
      return sticky
    })

    const first = await callGetDistroOptions({})
    expect(first).toEqual({ available: true, distros: [], default: null })
    expect(listWslDistrosAsyncMock).toHaveBeenNthCalledWith(1, { refresh: false })

    const refreshed = await callGetDistroOptions({ refresh: true })
    expect(refreshed).toEqual({ available: true, distros: ['Ubuntu', 'Debian'], default: 'Ubuntu' })
    expect(listWslDistrosAsyncMock).toHaveBeenLastCalledWith({ refresh: true })
    expect(isWslAvailableAsyncMock).toHaveBeenLastCalledWith({ refresh: true })
  })

  it('reports availability with no distros distinctly from unavailable', async () => {
    isWslAvailableAsyncMock.mockResolvedValue(true)
    listWslDistrosAsyncMock.mockResolvedValue([])
    await expect(callGetDistroOptions({})).resolves.toEqual({
      available: true,
      distros: [],
      default: null
    })
  })

  // ── WSL add branch ────────────────────────────────────────────────

  it('stores the modern UNC share, stays local, and stamps the project runtime pref', async () => {
    const result = await withWin32(() =>
      callAdd({ wsl: { distro: 'Ubuntu', linuxPath: '/home/j/app' }, kind: 'git' })
    )

    expect(result).toHaveProperty('repo')
    const added = mockStore.addRepo.mock.calls[0][0] as Repo
    expect(added.path).toBe('\\\\wsl.localhost\\Ubuntu\\home\\j\\app')
    expect(added.kind).toBe('git')
    // Local repo: no SSH connection identity.
    expect(added.connectionId ?? null).toBeNull()

    expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledWith(
      '\\\\wsl.localhost\\Ubuntu\\home\\j\\app'
    )
    expect(mockStore.updateProject).toHaveBeenCalledWith(`project::${added.id}`, {
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
  })

  it('rejects the add when the distro reports the directory is missing', async () => {
    wslUncDirectoryExistsAsyncMock.mockResolvedValue(false)
    const result = await withWin32(() =>
      callAdd({ wsl: { distro: 'Ubuntu', linuxPath: '/home/j/missing' }, kind: 'git' })
    )
    expect(result).toMatchObject({ error: expect.stringContaining('/home/j/missing') })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
    expect(mockStore.updateProject).not.toHaveBeenCalled()
  })

  it('dedups a WSL add against an existing repo that differs only by legacy prefix, stamping the runtime pref', async () => {
    repos.push({
      id: 'existing',
      path: '\\\\wsl$\\Ubuntu\\home\\j\\app',
      displayName: 'app',
      badgeColor: '#000000',
      addedAt: 0,
      kind: 'git'
    } as Repo)

    const result = await withWin32(() =>
      callAdd({ wsl: { distro: 'Ubuntu', linuxPath: '/home/j/app' }, kind: 'git' })
    )

    expect(result).toEqual({ repo: repos[0] })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
    // A legacy \\wsl$\ re-add must still gain WSL routing on the reuse path.
    expect(mockStore.updateProject).toHaveBeenCalledWith('project::existing', {
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })
  })

  it('resolves and stores the git top-level root for a nested WSL git path', async () => {
    resolveWslGitRepoRootAsyncMock.mockResolvedValue('/home/j/app')

    const result = await withWin32(() =>
      callAdd({ wsl: { distro: 'Ubuntu', linuxPath: '/home/j/app/packages/api' }, kind: 'git' })
    )

    expect(result).toHaveProperty('repo')
    expect(resolveWslGitRepoRootAsyncMock).toHaveBeenCalledWith(
      'Ubuntu',
      '/home/j/app/packages/api'
    )
    const added = mockStore.addRepo.mock.calls[0][0] as Repo
    expect(added.path).toBe('\\\\wsl.localhost\\Ubuntu\\home\\j\\app')
  })

  it('skips git-root resolution for folder-kind WSL adds', async () => {
    await withWin32(() =>
      callAdd({ wsl: { distro: 'Ubuntu', linuxPath: '/home/j/docs' }, kind: 'folder' })
    )
    expect(resolveWslGitRepoRootAsyncMock).not.toHaveBeenCalled()
    const added = mockStore.addRepo.mock.calls[0][0] as Repo
    expect(added.path).toBe('\\\\wsl.localhost\\Ubuntu\\home\\j\\docs')
  })

  it('refuses WSL adds off Windows', async () => {
    const original = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      const result = await callAdd({
        wsl: { distro: 'Ubuntu', linuxPath: '/home/j/app' },
        kind: 'git'
      })
      expect(result).toMatchObject({ error: expect.stringContaining('Windows') })
      expect(mockStore.addRepo).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: original })
    }
  })

  // ── legacy-prefix normalization (pure) ────────────────────────────

  it('normalizes a legacy \\\\wsl$\\ prefix to \\\\wsl.localhost\\', () => {
    expect(normalizeWslUncPrefix('\\\\wsl$\\Ubuntu\\home\\j\\app')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\j\\app'
    )
  })

  it('treats \\\\wsl$\\ and \\\\wsl.localhost\\ paths as equal for comparison', () => {
    expect(normalizeRuntimePathForComparison('\\\\wsl$\\Ubuntu\\home\\j\\app')).toBe(
      normalizeRuntimePathForComparison('\\\\wsl.localhost\\Ubuntu\\home\\j\\app')
    )
  })
})
