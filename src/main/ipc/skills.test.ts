import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  discoverSkillsMock,
  inventorySkillFreshnessMock,
  getDefaultWslDistroMock,
  getWslHomeMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  discoverSkillsMock: vi.fn(),
  inventorySkillFreshnessMock: vi.fn(),
  getDefaultWslDistroMock: vi.fn(),
  getWslHomeMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('../skills/discovery', () => ({
  discoverSkills: discoverSkillsMock
}))

vi.mock('../skills/skill-freshness-inventory', () => ({
  inventorySkillFreshness: inventorySkillFreshnessMock
}))

vi.mock('../wsl', () => ({
  getDefaultWslDistro: getDefaultWslDistroMock,
  getWslHome: getWslHomeMock
}))

import { registerSkillsHandlers } from './skills'

describe('registerSkillsHandlers', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const repos = [{ id: 'repo-1', path: 'C:\\Users\\alice\\repo' }]
  const store = {
    getRepos: vi.fn(() => repos)
  }

  beforeEach(() => {
    handleMock.mockReset()
    discoverSkillsMock.mockReset()
    getDefaultWslDistroMock.mockReset()
    getWslHomeMock.mockReset()
    discoverSkillsMock.mockResolvedValue({ skills: [], sources: [], scannedAt: 1 })
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
    expect(discoverSkillsMock).toHaveBeenCalledWith({
      repos: [],
      homeDir: '\\\\wsl.localhost\\Ubuntu\\home\\alice',
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\alice'
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

    expect(inventorySkillFreshnessMock).toHaveBeenCalledWith({ repos })
    expect(getWslHomeMock).not.toHaveBeenCalled()
  })
})
