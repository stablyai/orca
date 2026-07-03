import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  discoverSkillsMock,
  discoverSkillsInWslMock,
  inventorySkillFreshnessMock,
  getDefaultWslDistroMock,
  getWslHomeMock,
  parseWslPathMock,
  callRuntimeEnvironmentMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  discoverSkillsMock: vi.fn(),
  discoverSkillsInWslMock: vi.fn(),
  inventorySkillFreshnessMock: vi.fn(),
  getDefaultWslDistroMock: vi.fn(),
  getWslHomeMock: vi.fn(),
  parseWslPathMock: vi.fn(),
  callRuntimeEnvironmentMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '9.9.9-test',
    getPath: () => '/mock/userData'
  },
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('../skills/discovery', () => ({
  discoverSkills: discoverSkillsMock
}))

vi.mock('../skills/skill-discovery-wsl', () => ({
  discoverSkillsInWsl: discoverSkillsInWslMock
}))

vi.mock('../skills/skill-freshness-inventory', () => ({
  inventorySkillFreshness: inventorySkillFreshnessMock
}))

vi.mock('../wsl', () => ({
  getDefaultWslDistro: getDefaultWslDistroMock,
  getWslHome: getWslHomeMock,
  parseWslPath: parseWslPathMock,
  toLinuxPath: (pathValue: string) => {
    if (pathValue === '\\\\wsl.localhost\\Ubuntu\\home\\alice') {
      return '/home/alice'
    }
    if (pathValue === 'C:\\repo\\worktree') {
      return '/mnt/c/repo/worktree'
    }
    return pathValue
  }
}))

vi.mock('./runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))

import { registerSkillsHandlers } from './skills'

describe('registerSkillsHandlers', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const repos = [{ id: 'repo-1', path: 'C:\\Users\\alice\\repo' }]
  const store = {
    getRepos: vi.fn(() => repos),
    getSettings: vi.fn(() => ({ activeRuntimeEnvironmentId: null as string | null }))
  }

  beforeEach(() => {
    handleMock.mockReset()
    discoverSkillsMock.mockReset()
    discoverSkillsInWslMock.mockReset()
    getDefaultWslDistroMock.mockReset()
    getWslHomeMock.mockReset()
    parseWslPathMock.mockReset()
    parseWslPathMock.mockReturnValue(null)
    callRuntimeEnvironmentMock.mockReset()
    store.getSettings.mockReturnValue({ activeRuntimeEnvironmentId: null })
    discoverSkillsMock.mockResolvedValue({ skills: [], sources: [], scannedAt: 1 })
    discoverSkillsInWslMock.mockResolvedValue({ skills: [], sources: [], scannedAt: 1 })
    inventorySkillFreshnessMock.mockResolvedValue({
      schemaVersion: 1,
      installations: [],
      eligibleUpdateNames: [],
      scannedAt: 1
    })
    getWslHomeMock.mockReturnValue('\\\\wsl.localhost\\Ubuntu\\home\\alice')
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  function getDiscoverHandler() {
    registerSkillsHandlers(store as never)
    const call = handleMock.mock.calls.find((entry: unknown[]) => entry[0] === 'skills:discover')
    if (!call) {
      throw new Error('skills:discover handler was not registered')
    }
    return call[1] as (_event: unknown, target?: unknown) => Promise<unknown>
  }

  function getFreshnessHandler() {
    registerSkillsHandlers(store as never)
    const call = handleMock.mock.calls.find(
      (entry: unknown[]) => entry[0] === 'skills:freshnessInventory'
    )
    if (!call) {
      throw new Error('skills:freshnessInventory handler was not registered')
    }
    return call[1] as (_event: unknown) => Promise<unknown>
  }

  it('uses host skill discovery when resolved project runtime overrides stale WSL target state', async () => {
    const handler = getDiscoverHandler()

    await handler(null, {
      runtime: 'wsl',
      wslDistro: 'Debian',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'windows-host',
          hostPlatform: 'win32',
          projectId: 'repo-1',
          reason: 'project-override',
          cacheKey: 'repo-1:windows-host'
        }
      }
    })

    expect(discoverSkillsMock).toHaveBeenCalledWith({ repos })
    expect(getWslHomeMock).not.toHaveBeenCalled()
  })

  it('scopes host skill discovery to the active workspace cwd when provided', async () => {
    const handler = getDiscoverHandler()

    await handler(null, { cwd: '/repo/worktree' })

    expect(discoverSkillsMock).toHaveBeenCalledWith({ repos: [], cwd: '/repo/worktree' })
  })

  it('uses the selected project WSL distro for skill discovery', async () => {
    const handler = getDiscoverHandler()

    await handler(null, {
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Ubuntu',
          reason: 'project-override',
          cacheKey: 'repo-1:wsl:Ubuntu'
        }
      }
    })

    expect(getDefaultWslDistroMock).not.toHaveBeenCalled()
    expect(getWslHomeMock).toHaveBeenCalledWith('Ubuntu')
    expect(discoverSkillsInWslMock).toHaveBeenCalledWith({
      distro: 'Ubuntu',
      homeDir: '/home/alice',
      cwd: '/home/alice'
    })
  })

  it('scans the requested project directory in the selected WSL runtime', async () => {
    const handler = getDiscoverHandler()

    await handler(null, {
      cwd: 'C:\\repo\\worktree',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Ubuntu',
          reason: 'project-override',
          cacheKey: 'repo-1:wsl:Ubuntu'
        }
      }
    })

    expect(discoverSkillsInWslMock).toHaveBeenCalledWith({
      distro: 'Ubuntu',
      homeDir: '/home/alice',
      cwd: '/mnt/c/repo/worktree'
    })
  })

  it('blocks skill discovery when project runtime requires repair', async () => {
    const handler = getDiscoverHandler()

    await expect(
      handler(null, {
        projectRuntime: {
          status: 'repair-required',
          repair: {
            projectId: 'repo-1',
            preferredRuntime: { kind: 'wsl', distro: 'Ubuntu' },
            reason: 'wsl-distro-missing',
            source: 'project-override',
            cacheKey: 'repo-1:repair:wsl-distro-missing:Ubuntu'
          }
        }
      })
    ).rejects.toThrow('Project runtime requires repair before skill discovery')
    expect(discoverSkillsMock).not.toHaveBeenCalled()
  })

  it('keeps freshness inventory local and read-only over known repositories', async () => {
    const handler = getFreshnessHandler()

    await handler(null)

    expect(inventorySkillFreshnessMock).toHaveBeenCalledWith({
      currentAppVersion: '9.9.9-test',
      repos
    })
    expect(getWslHomeMock).not.toHaveBeenCalled()
  })

  describe('remote runtime proxying', () => {
    const remoteResult = {
      skills: [{ id: 'orchestration' }],
      sources: [{ kind: 'user' }],
      scannedAt: 42
    }

    beforeEach(() => {
      store.getSettings.mockReturnValue({ activeRuntimeEnvironmentId: 'env-1' })
    })

    it('proxies discovery to the active remote runtime and returns its result', async () => {
      callRuntimeEnvironmentMock.mockResolvedValue({
        id: 'skills.discover',
        ok: true,
        result: remoteResult,
        _meta: { runtimeId: 'runtime-1' }
      })
      const handler = getDiscoverHandler()

      await expect(handler(null, { cwd: '/srv/repo' })).resolves.toEqual(remoteResult)
      expect(callRuntimeEnvironmentMock).toHaveBeenCalledWith(
        '/mock/userData',
        'env-1',
        'skills.discover',
        { cwd: '/srv/repo' },
        15_000
      )
      // Why: while a remote runtime is active the local scan must not run.
      expect(discoverSkillsMock).not.toHaveBeenCalled()
    })

    it('returns an empty result (never a local scan) when the remote returns ok:false', async () => {
      callRuntimeEnvironmentMock.mockResolvedValue({
        id: 'skills.discover',
        ok: false,
        error: { code: 'runtime_unavailable', message: 'remote refused' },
        _meta: { runtimeId: null }
      })
      const handler = getDiscoverHandler()

      const result = (await handler(null)) as { skills: unknown[]; sources: unknown[] }
      expect(result.skills).toEqual([])
      expect(result.sources).toEqual([])
      expect(discoverSkillsMock).not.toHaveBeenCalled()
    })

    it('returns an empty result when the remote host is unreachable', async () => {
      callRuntimeEnvironmentMock.mockRejectedValue(new Error('connect ETIMEDOUT'))
      const handler = getDiscoverHandler()

      const result = (await handler(null)) as { skills: unknown[]; sources: unknown[] }
      expect(result.skills).toEqual([])
      expect(result.sources).toEqual([])
      expect(discoverSkillsMock).not.toHaveBeenCalled()
    })

    it('runs the local scan when no remote runtime is active', async () => {
      store.getSettings.mockReturnValue({ activeRuntimeEnvironmentId: null })
      const handler = getDiscoverHandler()

      await handler(null, { cwd: '/repo/worktree' })

      expect(callRuntimeEnvironmentMock).not.toHaveBeenCalled()
      expect(discoverSkillsMock).toHaveBeenCalledWith({ repos: [], cwd: '/repo/worktree' })
    })
  })
})
