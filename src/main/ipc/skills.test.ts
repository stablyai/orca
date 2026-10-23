import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  discoverSkillsMock,
  discoverSkillObservationInWslMock,
  getDefaultWslDistroMock,
  getWslHomeMock,
  parseWslPathMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  discoverSkillsMock: vi.fn(),
  discoverSkillObservationInWslMock: vi.fn(),
  getDefaultWslDistroMock: vi.fn(),
  getWslHomeMock: vi.fn(),
  parseWslPathMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '9.9.9-test'
  },
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('./skill-ipc-main-window', () => ({
  handleMainWindowSkillIpc: (channel: string, handler: unknown) => handleMock(channel, handler)
}))

vi.mock('../skills/discovery', () => ({
  discoverSkills: discoverSkillsMock,
  clearSkillRootScanCache: vi.fn()
}))

vi.mock('../skills/skill-discovery-wsl', () => ({
  discoverSkillObservationInWsl: discoverSkillObservationInWslMock
}))

vi.mock('./skill-cloud-ipc-handlers', () => ({
  registerSkillCloudIpcHandlers: vi.fn()
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

import { registerSkillsHandlers } from './skills'
import { clearSkillDiscoveryCaches } from '../skills/skill-discovery-target'

describe('registerSkillsHandlers', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const repos = [{ id: 'repo-1', path: 'C:\\Users\\alice\\repo' }]
  const store = {
    getRepos: vi.fn(() => repos)
  }

  beforeEach(() => {
    clearSkillDiscoveryCaches()
    handleMock.mockReset()
    discoverSkillsMock.mockReset()
    discoverSkillObservationInWslMock.mockReset()
    getDefaultWslDistroMock.mockReset()
    getWslHomeMock.mockReset()
    parseWslPathMock.mockReset()
    parseWslPathMock.mockReturnValue(null)
    discoverSkillsMock.mockResolvedValue({ skills: [], sources: [], scannedAt: 1 })
    discoverSkillObservationInWslMock.mockResolvedValue({ rows: [], sources: [], scannedAt: 1 })
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

  function handlerFor(channel: string) {
    const call = handleMock.mock.calls.find((entry: unknown[]) => entry[0] === channel)
    if (!call) {
      throw new Error(`${channel} handler was not registered`)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ipcMain.handle mock records the listener registered for this channel.
    return call[1] as (_event: unknown, value?: unknown) => Promise<unknown>
  }

  function bundledRuntime() {
    return {
      resolveSkillDiscoveryProviderRoots: vi.fn(),
      planLocalBundledSkills: vi.fn().mockResolvedValue({ planned: true }),
      executeLocalBundledSkills: vi.fn().mockResolvedValue({ executed: true })
    }
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

    expect(discoverSkillsMock).toHaveBeenCalledWith({ repos, refresh: false })
    expect(getWslHomeMock).not.toHaveBeenCalled()
  })

  it('scopes host skill discovery to the active workspace cwd when provided', async () => {
    const handler = getDiscoverHandler()

    await handler(null, { cwd: '/repo/worktree' })

    expect(discoverSkillsMock).toHaveBeenCalledWith({
      repos: [],
      cwd: '/repo/worktree',
      refresh: false
    })
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
    expect(discoverSkillObservationInWslMock).toHaveBeenCalledWith({
      distro: 'Ubuntu',
      homeDir: '/home/alice',
      sourceKinds: undefined
    })
  })

  it('shares the home and bundled WSL scan across name-filtered requests', async () => {
    const handler = getDiscoverHandler()

    for (const name of ['orchestration', 'linear-tickets']) {
      await handler(null, {
        runtime: 'wsl',
        wslDistro: 'Ubuntu',
        names: [name],
        sourceKinds: ['home']
      })
    }

    expect(discoverSkillObservationInWslMock).toHaveBeenCalledOnce()
    expect(discoverSkillObservationInWslMock).toHaveBeenCalledWith({
      distro: 'Ubuntu',
      homeDir: '/home/alice',
      sourceKinds: ['bundled', 'home']
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

    expect(discoverSkillObservationInWslMock).toHaveBeenCalledWith({
      distro: 'Ubuntu',
      homeDir: '/home/alice',
      cwd: '/mnt/c/repo/worktree',
      sourceKinds: undefined
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

  it('registers the bundled-skill plan and execute channels only with a runtime', () => {
    registerSkillsHandlers(store as never)
    const channels = handleMock.mock.calls.map((entry: unknown[]) => entry[0])
    expect(channels).not.toContain('skills:bundledPlan')
    expect(channels).not.toContain('skills:bundledExecute')
  })

  it('plans and executes the local host with the parsed request', async () => {
    const runtime = bundledRuntime()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double implements only the members this code path reads.
    registerSkillsHandlers(store as never, runtime as never)
    const force = ['/home/u/.claude/skills/orca-cli']
    const planDigest = 'c'.repeat(64)

    await expect(handlerFor('skills:bundledPlan')(null, undefined)).resolves.toEqual({
      planned: true
    })
    await handlerFor('skills:bundledPlan')(null, { force })
    await expect(
      handlerFor('skills:bundledExecute')(null, { planDigest, request: { force } })
    ).resolves.toEqual({ executed: true })

    expect(runtime.planLocalBundledSkills.mock.calls).toEqual([[{}], [{ force }]])
    expect(runtime.executeLocalBundledSkills).toHaveBeenCalledWith({
      planDigest,
      request: { force }
    })
    expect(getWslHomeMock).not.toHaveBeenCalled()
  })

  it('rejects malformed bundled-skill requests before reaching the runtime', async () => {
    const runtime = bundledRuntime()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double implements only the members this code path reads.
    registerSkillsHandlers(store as never, runtime as never)

    await expect(
      handlerFor('skills:bundledPlan')(null, { wsl: { distro: 'Ubuntu' } })
    ).rejects.toThrow()
    await expect(
      handlerFor('skills:bundledExecute')(null, {
        planDigest: 'd'.repeat(64),
        request: { wsl: { distro: 'Ubuntu' } }
      })
    ).rejects.toThrow()
    await expect(handlerFor('skills:bundledPlan')(null, { force: 'all' })).rejects.toThrow()
    await expect(handlerFor('skills:bundledPlan')(null, { names: ['../x'] })).rejects.toThrow()
    await expect(handlerFor('skills:bundledExecute')(null, {})).rejects.toThrow()
    await expect(
      handlerFor('skills:bundledExecute')(null, { planDigest: 'not-a-digest' })
    ).rejects.toThrow()
    expect(runtime.planLocalBundledSkills).not.toHaveBeenCalled()
    expect(runtime.executeLocalBundledSkills).not.toHaveBeenCalled()
  })
})
