import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslUncAccessGateModule from '../wsl/wsl-unc-access-gate'

const {
  registerSkillCloudIpcHandlersMock,
  handleMock,
  discoverSkillsMock,
  discoverSkillObservationInWslMock,
  getDefaultWslDistroMock,
  getWslHomeMock,
  parseWslPathMock,
  assertWslUncPathRunningMock
} = vi.hoisted(() => ({
  registerSkillCloudIpcHandlersMock: vi.fn(),
  assertWslUncPathRunningMock: vi.fn(),
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

vi.mock('../wsl/wsl-unc-access-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof WslUncAccessGateModule>()),
  assertWslUncPathRunning: assertWslUncPathRunningMock
}))

vi.mock('./skill-cloud-ipc-handlers', () => ({
  registerSkillCloudIpcHandlers: registerSkillCloudIpcHandlersMock
}))

vi.mock('../wsl', () => ({
  getDefaultWslDistro: getDefaultWslDistroMock,
  getWslHome: getWslHomeMock,
  getWslHomeAsync: async (distro: string) => getWslHomeMock(distro),
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
import { WslDistroStoppedError, WslDistroUnverifiableError } from '../wsl/wsl-unc-access-gate'

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
    assertWslUncPathRunningMock.mockReset().mockResolvedValue(undefined)
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

  it.each([
    ['stopped', new WslDistroStoppedError('Ubuntu')],
    ['unverifiable', new WslDistroUnverifiableError('Ubuntu')]
  ])(
    'answers nothing yet for a %s WSL target, without probing its home or scanning in it',
    async (_state, refusal) => {
      assertWslUncPathRunningMock.mockRejectedValue(refusal)
      const handler = getDiscoverHandler()
      const result = await handler(null, { runtime: 'wsl', wslDistro: 'Ubuntu' })

      expect(assertWslUncPathRunningMock).toHaveBeenCalledWith('', 'Ubuntu')
      expect(getWslHomeMock).not.toHaveBeenCalled()
      expect(discoverSkillObservationInWslMock).not.toHaveBeenCalled()
      // Unknown, not absent: every source is unavailable, so no surface offers Install.
      expect(result).toMatchObject({
        skills: [],
        sources: expect.arrayContaining([expect.objectContaining({ skippedReason: 'unavailable' })])
      })
      expect(result).not.toMatchObject({
        sources: expect.arrayContaining([
          expect.not.objectContaining({ skippedReason: 'unavailable' })
        ])
      })
    }
  )

  it('lets an explicit Share discover skills in a stopped distro, as the user act it is', async () => {
    assertWslUncPathRunningMock.mockRejectedValue(new WslDistroStoppedError('Ubuntu'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration reads only getRepos and the runtime's provider roots, as the bundled-skill tests do.
    registerSkillsHandlers(store as never, bundledRuntime() as never)
    const shareDiscover = registerSkillCloudIpcHandlersMock.mock.lastCall?.[1]
    expect(shareDiscover).toBeTypeOf('function')

    await shareDiscover({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    expect(assertWslUncPathRunningMock).not.toHaveBeenCalled()
    expect(getWslHomeMock).toHaveBeenCalledWith('Ubuntu')
    expect(discoverSkillObservationInWslMock).toHaveBeenCalled()
  })

  it('lets the Share dialog, which sends no target, read a stopped distro’s repo skills', async () => {
    registerSkillsHandlers(store as never, bundledRuntime() as never) // oxlint-disable-line typescript/consistent-type-assertions -- SAFETY: registration reads only getRepos and the runtime's provider roots.
    const shareDiscover = registerSkillCloudIpcHandlersMock.mock.lastCall?.[1]

    await shareDiscover(undefined)

    expect(discoverSkillsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ repos, gateStoppedWslDistros: false })
    )
  })

  it('keeps passive discovery gated', async () => {
    const handler = getDiscoverHandler()
    await handler(null, undefined)
    expect(discoverSkillsMock).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ gateStoppedWslDistros: false })
    )
  })

  it('never asks the WSL gate for a host target', async () => {
    const handler = getDiscoverHandler()
    await handler(null, { runtime: 'host' })
    expect(assertWslUncPathRunningMock).not.toHaveBeenCalled()
    expect(discoverSkillsMock).toHaveBeenCalled()
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
