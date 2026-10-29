import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'
import type * as RepoModule from '../git/repo'

const { reposMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./repos-remote-test-harness')
  return { reposMocks: moduleMocks.createReposIpcMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(reposMocks))
vi.mock('../git/repo', async (importOriginal) =>
  moduleMocks.gitRepoModuleMock(await importOriginal<typeof RepoModule>())
)
vi.mock('../git/runner', async (importOriginal) =>
  moduleMocks.gitRunnerModuleMock(reposMocks, await importOriginal<typeof GitRunner>())
)
vi.mock('../git/worktree', () => moduleMocks.gitWorktreeModuleMock(reposMocks))
vi.mock('./registered-worktree-roots-cache', () =>
  moduleMocks.registeredWorktreeRootsCacheModuleMock(reposMocks)
)
vi.mock('../worktree-root-preparation', () =>
  moduleMocks.worktreeRootPreparationModuleMock(reposMocks)
)

import { registerRepoHandlers } from './repos'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'
import { clearGitCapabilityStateForTests } from '../git/git-capability-state'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { createRepoHandlerHarness } from './repos-remote-test-harness'
import { getBaseRefDefault, getRemoteCount } from '../git/repo'

const { handleMock, mockStore, gitExecFileAsyncMock, prepareLocalWorktreeRootForRepoMock } =
  reposMocks

beforeEach(() => {
  clearGitCapabilityStateForTests()
  resetSshProviderAuthorities()
})

describe('repos:getBaseRefDefault envelope', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()

  beforeEach(() => {
    captureHandlers(handleMock)
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.getRepo.mockReset()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)
    gitExecFileAsyncMock.mockReset()
    vi.mocked(getBaseRefDefault).mockClear()
    registerRepoHandlers(mockWindow as never, mockStore as never, {} as never)
  })

  it('returns { defaultBaseRef, remoteCount: 0 } for folder-mode repos', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/some/folder',
      kind: 'folder'
    })

    const result = await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })

    expect(result).toEqual({ defaultBaseRef: null, remoteCount: 0 })
  })

  it('returns { defaultBaseRef: null, remoteCount: 0 } for an unknown repoId', async () => {
    mockStore.getRepo.mockReturnValue(undefined)

    const result = await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'missing' })

    expect(result).toEqual({ defaultBaseRef: null, remoteCount: 0 })
  })

  it('wraps the local getBaseRefDefault result in the envelope', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/repo',
      kind: 'git'
    })

    const result = (await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })) as {
      defaultBaseRef: string | null
      remoteCount: number
    }

    expect(result.defaultBaseRef).toBe('origin/main')
    expect(result.remoteCount).toBe(1)
  })

  it('returns { defaultBaseRef: null, remoteCount: 0 } for an SSH repo without running git', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })

    expect(result).toEqual({ defaultBaseRef: null, remoteCount: 0 })
    expect(getBaseRefDefault).not.toHaveBeenCalled()
  })
})

describe('repos:searchBaseRefs on SSH repos', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()

  beforeEach(() => {
    captureHandlers(handleMock)
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.getRepo.mockReset()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)
    gitExecFileAsyncMock.mockReset()
    vi.mocked(getBaseRefDefault).mockClear()
    registerRepoHandlers(mockWindow as never, mockStore as never, {} as never)
  })

  it('returns [] for a folder-mode repo without invoking the relay', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/some/folder',
      kind: 'folder',
      connectionId: 'conn-1'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: 'main'
    })

    expect(result).toEqual([])
  })

  it('returns [] for an SSH repo without running git', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'conn-1',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefDetails')!(null, {
      repoId: 'r1',
      query: 'main'
    })

    expect(result).toEqual([])
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('returns [] when the SSH provider is not connected', async () => {
    mockStore.getRepo.mockReturnValue({
      id: 'r1',
      path: '/remote/repo',
      connectionId: 'unknown-conn',
      kind: 'git'
    })

    const result = await handlers.get('repos:searchBaseRefs')!(null, {
      repoId: 'r1',
      query: 'main'
    })

    expect(result).toEqual([])
  })
})

describe('base-ref queries on a drive project whose runtime is WSL', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()
  const originalPlatform = process.platform
  const repo = { id: 'r1', path: String.raw`C:\repo`, kind: 'git' }

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    captureHandlers(handleMock)
    mockStore.getRepo.mockReset().mockReturnValue(repo)
    mockStore.getProjects
      .mockReset()
      .mockReturnValue([{ id: 'p1', sourceRepoIds: ['r1'], createdAt: 0, updatedAt: 0 }])
    Object.assign(mockStore, {
      getSettings: () => ({ localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } })
    })
    gitExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
    vi.mocked(getBaseRefDefault).mockClear()
    registerRepoHandlers(mockWindow as never, mockStore as never, {} as never)
    return () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
      vi.unstubAllEnvs()
      Reflect.deleteProperty(mockStore, 'getSettings')
    }
  })

  it('reads the default base and remote count with the distro Git', async () => {
    await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })

    expect(getBaseRefDefault).toHaveBeenCalledWith(repo.path, { wslDistro: 'Ubuntu' })
    expect(getRemoteCount).toHaveBeenCalledWith(repo.path, { wslDistro: 'Ubuntu' })
  })

  it('reads with host Git, as before, while WSL hosts are off', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    await handlers.get('repos:getBaseRefDefault')!(null, { repoId: 'r1' })
    await handlers.get('repos:searchBaseRefDetails')!(null, { repoId: 'r1', query: 'main' })

    expect(getBaseRefDefault).toHaveBeenCalledWith(repo.path, {})
    expect(getRemoteCount).toHaveBeenCalledWith(repo.path, {})
    const commands = gitExecFileAsyncMock.mock.calls.map(([args, options]) => [args[0], options])
    expect(commands).toContainEqual(['for-each-ref', { cwd: repo.path }])
  })

  it('searches base refs with the distro Git', async () => {
    await handlers.get('repos:searchBaseRefDetails')!(null, { repoId: 'r1', query: 'main' })

    const commands = gitExecFileAsyncMock.mock.calls.map(([args, options]) => [args[0], options])
    expect(commands).toContainEqual(['remote', { cwd: repo.path, wslDistro: 'Ubuntu' }])
    expect(commands).toContainEqual(['for-each-ref', { cwd: repo.path, wslDistro: 'Ubuntu' }])
  })
})
