import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Store } from './persistence'
import type { Project } from '../shared/project-types'
import type { Repo } from '../shared/repo-types'
import {
  getLocalProjectGitExecOptions,
  getWorktreeCreatePrefetchGitOptions,
  getWorktreeMirrorDistro,
  resolveLocalProjectRuntimeForRepo
} from './project-runtime-git-options'
import { _resetWslCachesForTests, _setWslCachesForTests } from './wsl'

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const originalPlatform = process.platform
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  }
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    displayName: 'Repo',
    path: String.raw`C:\repo`,
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    displayName: 'Project',
    badgeColor: '#000000',
    sourceRepoIds: ['repo-1'],
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function makeStore(project: Project): Store {
  return {
    getProjects: () => [project],
    getSettings: () => ({ localWindowsRuntimeDefault: { kind: 'windows-host' } })
  } as unknown as Store
}

describe('project runtime git options', () => {
  afterEach(() => {
    _resetWslCachesForTests()
  })

  it('does not probe or repair WSL git routing before capability caches exist', () => {
    const project = makeProject({
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    const options = withPlatform('win32', () =>
      getLocalProjectGitExecOptions(makeStore(project), makeRepo())
    )

    expect(options).toEqual({ cwd: String.raw`C:\repo`, wslDistro: 'Ubuntu' })
  })

  it('returns repair state for missing cached WSL distro before local git execution', () => {
    _setWslCachesForTests({ available: true, distros: ['Debian'] })
    const project = makeProject({
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    const runtime = withPlatform('win32', () =>
      resolveLocalProjectRuntimeForRepo(makeStore(project), makeRepo())
    )

    expect(runtime).toEqual({
      status: 'repair-required',
      repair: {
        projectId: 'project-1',
        preferredRuntime: { kind: 'wsl', distro: 'Ubuntu' },
        reason: 'wsl-distro-missing',
        source: 'project-override',
        cacheKey: 'project-1:repair:wsl-distro-missing:Ubuntu'
      }
    })
    expect(() =>
      withPlatform('win32', () => getLocalProjectGitExecOptions(makeStore(project), makeRepo()))
    ).toThrow('Project runtime requires repair before git execution: wsl-distro-missing')
  })

  it('returns repair state for cached WSL unavailable before local git execution', () => {
    _setWslCachesForTests({ available: false, distros: [] })
    const project = makeProject({
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    expect(() =>
      withPlatform('win32', () => getLocalProjectGitExecOptions(makeStore(project), makeRepo()))
    ).toThrow('Project runtime requires repair before git execution: wsl-unavailable')
  })

  it('keeps project host override on host even when cached WSL is unavailable', () => {
    _setWslCachesForTests({ available: false, distros: [] })
    const project = makeProject({
      localWindowsRuntimePreference: { kind: 'windows-host' }
    })

    const options = withPlatform('win32', () =>
      getLocalProjectGitExecOptions(makeStore(project), makeRepo())
    )

    expect(options).toEqual({ cwd: String.raw`C:\repo` })
  })

  it('does not apply local Windows runtime routing to SSH-owned repos', () => {
    const project = makeProject({
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    const runtime = withPlatform('win32', () =>
      resolveLocalProjectRuntimeForRepo(
        makeStore(project),
        makeRepo({ connectionId: null, executionHostId: 'ssh:target-1' })
      )
    )

    expect(runtime).toBeUndefined()
  })

  describe('getWorktreeMirrorDistro', () => {
    it('names the distro a resolved WSL project runs in', () => {
      _setWslCachesForTests({ available: true, distros: ['Ubuntu'] })
      const project = makeProject({
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })

      expect(
        withPlatform('win32', () => getWorktreeMirrorDistro(makeStore(project), makeRepo()))
      ).toBe('Ubuntu')
    })

    it('names no distro for a host-runtime project', () => {
      const project = makeProject({ localWindowsRuntimePreference: { kind: 'windows-host' } })

      expect(
        withPlatform('win32', () => getWorktreeMirrorDistro(makeStore(project), makeRepo()))
      ).toBeUndefined()
    })

    // Placement must not throw where git execution does: a project awaiting
    // repair still gets a worktree, on the Windows side as it always has.
    it('names no distro instead of throwing when the runtime needs repair', () => {
      _setWslCachesForTests({ available: true, distros: ['Debian'] })
      const project = makeProject({
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })

      expect(
        withPlatform('win32', () => getWorktreeMirrorDistro(makeStore(project), makeRepo()))
      ).toBeUndefined()
    })

    it('names no distro when the store cannot resolve projects', () => {
      _setWslCachesForTests({ available: true, distros: ['Ubuntu'] })

      expect(withPlatform('win32', () => getWorktreeMirrorDistro({}, makeRepo()))).toBeUndefined()
    })
  })

  describe('getWorktreeCreatePrefetchGitOptions', () => {
    it('routes the warm-up through the distro a resolved WSL project runs in', () => {
      _setWslCachesForTests({ available: true, distros: ['Ubuntu'] })
      const project = makeProject({
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })

      expect(
        withPlatform('win32', () =>
          getWorktreeCreatePrefetchGitOptions(makeStore(project), makeRepo())
        )
      ).toEqual({ wslDistro: 'Ubuntu' })
    })

    // A speculative warm-up must degrade to the host Git it used before routing
    // existed, never surface the repair state git execution raises.
    it('falls back to host git instead of throwing when the runtime needs repair', () => {
      _setWslCachesForTests({ available: true, distros: ['Debian'] })
      const project = makeProject({
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })

      expect(
        withPlatform('win32', () =>
          getWorktreeCreatePrefetchGitOptions(makeStore(project), makeRepo())
        )
      ).toEqual({})
    })

    it('does not resolve a project runtime for folder workspaces', () => {
      _setWslCachesForTests({ available: true, distros: ['Ubuntu'] })
      const project = makeProject({
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      })
      const store = makeStore(project)
      const getProjects = vi.fn(store.getProjects)

      expect(
        withPlatform('win32', () =>
          getWorktreeCreatePrefetchGitOptions(
            { ...store, getProjects } as unknown as Store,
            makeRepo({ kind: 'folder' })
          )
        )
      ).toEqual({})
      expect(getProjects).not.toHaveBeenCalled()
    })
  })

  it('does not apply local Windows runtime routing to runtime-owned repos', () => {
    const project = makeProject({
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    const runtime = withPlatform('win32', () =>
      resolveLocalProjectRuntimeForRepo(
        makeStore(project),
        makeRepo({ connectionId: null, executionHostId: 'runtime:env-1' })
      )
    )

    expect(runtime).toBeUndefined()
  })
})
