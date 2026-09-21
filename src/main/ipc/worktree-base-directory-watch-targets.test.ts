import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join, sep } from 'node:path'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'

const { getSshFilesystemProviderMock, readFileMock, realpathMock, statMock } = vi.hoisted(() => ({
  getSshFilesystemProviderMock: vi.fn(),
  readFileMock: vi.fn(),
  realpathMock: vi.fn(),
  statMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  realpath: realpathMock,
  stat: statMock
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock
}))

import {
  buildWorktreeBaseDirectoryWatchTargets,
  clearWorktreeBaseDirectoryWatchTargetWarnings,
  WORKTREE_BASE_TARGET_RESOLUTION_CONCURRENCY
} from './worktree-base-directory-watch-targets'

const absolutePath = (...parts: string[]): string => join(sep, ...parts)
const WORKTREE_ROOT = absolutePath('workspace', 'worktrees')
const PROJECT_ROOT = absolutePath('workspace', 'projects')
const localDirectoryStat = { isDirectory: () => true }
const remoteDirectoryStat = { type: 'directory', size: 0, mtime: 0 }
const settings = {
  workspaceDir: WORKTREE_ROOT,
  nestWorkspaces: true
} as GlobalSettings

function makeRepo(index: number, overrides: Partial<Repo> = {}): Repo {
  return {
    id: `repo-${index}`,
    path: join(PROJECT_ROOT, `project-${index}`),
    displayName: `Project ${index}`,
    badgeColor: '#000000',
    addedAt: index,
    ...overrides
  } as Repo
}

function makeStore(repos: Repo[]) {
  return {
    getSettings: () => settings,
    getRepos: () => repos
  }
}

function makeRemoteProvider() {
  return {
    stat: vi.fn(async () => remoteDirectoryStat),
    realpath: vi.fn(async (path: string) => path),
    readFile: vi.fn(async () => ({ content: '', isBinary: false }))
  }
}

describe('worktree base directory watch target resolution', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    statMock.mockReset().mockResolvedValue(localDirectoryStat)
    realpathMock.mockReset().mockImplementation(async (path: string) => path)
    readFileMock.mockReset().mockResolvedValue('')
    getSshFilesystemProviderMock.mockReset().mockReturnValue(undefined)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    clearWorktreeBaseDirectoryWatchTargetWarnings()
    warnSpy.mockRestore()
  })

  it('bounds resolution concurrency and starts one successor per released slot', async () => {
    const repos = Array.from(
      { length: WORKTREE_BASE_TARGET_RESOLUTION_CONCURRENCY + 4 },
      (_, index) => makeRepo(index)
    )
    const gates = repos.map(() => Promise.withResolvers<void>())
    let startedRootStats = 0
    let activeRootStats = 0
    let peakRootStats = 0
    statMock.mockImplementation(async (path: string) => {
      if (path === WORKTREE_ROOT) {
        const gate = gates[startedRootStats++]
        activeRootStats++
        peakRootStats = Math.max(peakRootStats, activeRootStats)
        await gate.promise
        activeRootStats--
      }
      return localDirectoryStat
    })

    const resultPromise = buildWorktreeBaseDirectoryWatchTargets(makeStore(repos) as never)
    await vi.waitFor(() => {
      expect(startedRootStats).toBe(WORKTREE_BASE_TARGET_RESOLUTION_CONCURRENCY)
    })
    expect(peakRootStats).toBe(WORKTREE_BASE_TARGET_RESOLUTION_CONCURRENCY)

    gates[0].resolve()
    await vi.waitFor(() => {
      expect(startedRootStats).toBe(WORKTREE_BASE_TARGET_RESOLUTION_CONCURRENCY + 1)
    })
    expect(peakRootStats).toBe(WORKTREE_BASE_TARGET_RESOLUTION_CONCURRENCY)

    for (const gate of gates) {
      gate.resolve()
    }
    await resultPromise
    expect(startedRootStats).toBe(repos.length)
    expect(peakRootStats).toBe(WORKTREE_BASE_TARGET_RESOLUTION_CONCURRENCY)
  })

  it('merges targets and shared repo membership in store order after reverse completion', async () => {
    const repos = Array.from({ length: 4 }, (_, index) => makeRepo(index))
    const gates = repos.map(() => Promise.withResolvers<void>())
    const gitStatStarted = new Set<number>()
    const completionOrder: number[] = []
    statMock.mockImplementation(async (path: string) => {
      const index = repos.findIndex((repo) => path === join(repo.path, '.git'))
      if (index !== -1) {
        gitStatStarted.add(index)
        await gates[index].promise
        completionOrder.push(index)
      }
      return localDirectoryStat
    })

    const resultPromise = buildWorktreeBaseDirectoryWatchTargets(makeStore(repos) as never)
    await vi.waitFor(() => expect(gitStatStarted.size).toBe(repos.length))
    for (let index = repos.length - 1; index >= 0; index--) {
      gates[index].resolve()
      await vi.waitFor(() => expect(completionOrder).toContain(index))
    }
    const targets = await resultPromise

    expect(completionOrder).toEqual([3, 2, 1, 0])
    expect([...targets.values()].map((target) => [target.kind, target.path])).toEqual([
      ['base', WORKTREE_ROOT],
      ...repos.map((repo) => ['git-common', join(repo.path, '.git')])
    ])
    expect([...([...targets.values()][0]?.repos.keys() ?? [])]).toEqual(
      repos.map((repo) => repo.id)
    )
  })

  it('isolates missing paths to the affected repo', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const goodBefore = makeRepo(0, { worktreeBasePath: absolutePath('worktrees', 'before') })
    const unavailable = makeRepo(1, { worktreeBasePath: absolutePath('worktrees', 'missing') })
    const goodAfter = makeRepo(2, { worktreeBasePath: absolutePath('worktrees', 'after') })
    statMock.mockImplementation(async (path: string) => {
      if (path === unavailable.worktreeBasePath || path === join(unavailable.path, '.git')) {
        throw missing
      }
      return localDirectoryStat
    })

    const targets = await buildWorktreeBaseDirectoryWatchTargets(
      makeStore([goodBefore, unavailable, goodAfter]) as never
    )
    const repoIds = [...targets.values()].flatMap((target) => [...target.repos.keys()])

    expect(repoIds).toContain(goodBefore.id)
    expect(repoIds).not.toContain(unavailable.id)
    expect(repoIds).toContain(goodAfter.id)
  })

  it('keeps identical SSH paths isolated by connection and provider', async () => {
    const providerA = makeRemoteProvider()
    const providerB = makeRemoteProvider()
    getSshFilesystemProviderMock.mockImplementation((connectionId: string) =>
      connectionId === 'ssh-a' ? providerA : connectionId === 'ssh-b' ? providerB : undefined
    )
    const sharedPath = '/srv/project'
    const repos = [
      makeRepo(0, { path: sharedPath, connectionId: 'ssh-a' }),
      makeRepo(1, { path: sharedPath, connectionId: 'ssh-b' })
    ]

    const targets = await buildWorktreeBaseDirectoryWatchTargets(makeStore(repos) as never)

    expect(providerA.stat).toHaveBeenCalledTimes(2)
    expect(providerA.realpath).toHaveBeenCalledTimes(2)
    expect(providerB.stat).toHaveBeenCalledTimes(2)
    expect(providerB.realpath).toHaveBeenCalledTimes(2)
    expect([...targets.values()].map((target) => target.connectionId)).toEqual([
      'ssh-a',
      'ssh-a',
      'ssh-b',
      'ssh-b'
    ])
    expect(new Set(targets.keys()).size).toBe(4)
  })

  it('skips folder workspaces, unavailable SSH providers, and WSL UNC roots', async () => {
    const folder = makeRepo(0, { kind: 'folder' })
    const unavailableSsh = makeRepo(1, { connectionId: 'missing', path: '/srv/missing' })
    const wslPath = '\\\\wsl.localhost\\Ubuntu\\home\\alice\\project'
    const wsl = makeRepo(2, { path: wslPath, worktreeBasePath: wslPath })

    const targets = await buildWorktreeBaseDirectoryWatchTargets(
      makeStore([folder, unavailableSsh, wsl]) as never
    )

    expect(targets.size).toBe(0)
    expect(statMock).not.toHaveBeenCalled()
    expect(getSshFilesystemProviderMock).toHaveBeenCalledWith('missing')
  })

  // A mirrored layout puts the working trees inside the distro while the gitdir
  // stays on the Windows drive, so the UNC root skip must not take git-common with it.
  it('keeps the Windows-side git-common watcher when only the workspace root is a WSL UNC path', async () => {
    const repo = makeRepo(0, {
      path: 'C:\\Users\\alice\\orca',
      worktreeBasePath: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\workspaces'
    })

    const targets = await buildWorktreeBaseDirectoryWatchTargets(makeStore([repo]) as never)

    expect([...targets.values()].map((target) => target.kind)).toEqual(['git-common'])
    expect([...targets.values()][0]?.path).toBe('C:/Users/alice/orca/.git')
  })

  it('does not publish ordered partial targets when a repo resolver rejects unexpectedly', async () => {
    const completed = makeRepo(0)
    const broken = makeRepo(1)
    Object.defineProperty(broken, 'path', {
      get: () => {
        throw new Error('unexpected resolver failure')
      }
    })

    await expect(
      buildWorktreeBaseDirectoryWatchTargets(makeStore([completed, broken]) as never)
    ).rejects.toThrow('unexpected resolver failure')
    expect(statMock).toHaveBeenCalled()
  })
})
