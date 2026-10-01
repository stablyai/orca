import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import { _resetWslCachesForTests, _setWslCachesForTests } from '../wsl'

const mocks = vi.hoisted(() => ({
  prefetchWorktreeCreateBase: vi.fn(),
  requestWorktreeCreateSpare: vi.fn()
}))

vi.mock('../worktree-create-base-prefetch', () => ({
  prefetchWorktreeCreateBase: mocks.prefetchWorktreeCreateBase
}))
vi.mock('../worktree-create-preparation', () => ({
  beginWorktreeCreateSpareRequest: () => ({ seq: 1 }),
  requestWorktreeCreateSpare: mocks.requestWorktreeCreateSpare
}))

import { OrcaRuntimeService } from './orca-runtime'

const repo: Repo = {
  id: 'repo-1',
  displayName: 'Repo',
  path: String.raw`C:\workspace\repo`,
  badgeColor: '#000000',
  addedAt: 0
}

const project: Project = {
  id: 'project-1',
  displayName: 'Project',
  badgeColor: '#000000',
  sourceRepoIds: ['repo-1'],
  createdAt: 0,
  updatedAt: 0,
  localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
}

function makeStore(overrides: Partial<Project> = {}): unknown {
  return {
    getRepos: () => [repo],
    getRepo: (id: string) => (id === repo.id ? repo : undefined),
    getProjects: () => [{ ...project, ...overrides }],
    getSettings: () => ({ localWindowsRuntimeDefault: { kind: 'windows-host' } })
  }
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

const hostPlatform = process.platform

beforeEach(() => {
  mocks.prefetchWorktreeCreateBase.mockReset().mockResolvedValue(undefined)
  mocks.requestWorktreeCreateSpare.mockReset()
})

afterEach(() => {
  setPlatform(hostPlatform)
  _resetWslCachesForTests()
})

// The RPC/relay prefetch is the only warm-up a remote client reaches, so it has
// to resolve the same project runtime the IPC handler does. Constructed through
// the barrel because the split chain resolves selectors in a later subclass.
describe('prefetchManagedWorktreeCreateBase (orca-runtime-get-worktree-terminal-provisioning-host)', () => {
  it('warms up in the distro a WSL-routed project runs in', async () => {
    _setWslCachesForTests({ available: true, distros: ['Ubuntu'] })
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(makeStore() as never)

    await runtime.prefetchManagedWorktreeCreateBase({ repoSelector: 'repo-1' })

    expect(mocks.prefetchWorktreeCreateBase).toHaveBeenCalledWith(
      expect.objectContaining({ gitOptions: { wslDistro: 'Ubuntu' } })
    )
  })

  it('warms up on host git when no project runtime routes the repo', async () => {
    setPlatform('darwin')
    const runtime = new OrcaRuntimeService(makeStore() as never)

    await runtime.prefetchManagedWorktreeCreateBase({ repoSelector: 'repo-1' })

    expect(mocks.prefetchWorktreeCreateBase).toHaveBeenCalledWith(
      expect.objectContaining({ gitOptions: {} })
    )
  })

  // A repair-required runtime must degrade to host git, not fail the warm-up.
  it('does not surface a repair-required project runtime as a prefetch failure', async () => {
    _setWslCachesForTests({ available: true, distros: ['Debian'] })
    setPlatform('win32')
    const runtime = new OrcaRuntimeService(makeStore() as never)

    await expect(
      runtime.prefetchManagedWorktreeCreateBase({ repoSelector: 'repo-1' })
    ).resolves.toBeUndefined()

    expect(mocks.prefetchWorktreeCreateBase).toHaveBeenCalledWith(
      expect.objectContaining({ gitOptions: {} })
    )
  })

  it('requests a spare at the base only once the refresh settled, without waiting on it', async () => {
    setPlatform('darwin')
    let finishRefresh: (base: string) => void = () => {}
    mocks.prefetchWorktreeCreateBase.mockReturnValue(
      new Promise<string>((resolve) => {
        finishRefresh = resolve
      })
    )
    const runtime = new OrcaRuntimeService(makeStore() as never)

    const prefetch = runtime.prefetchManagedWorktreeCreateBase({ repoSelector: 'repo-1' })
    await vi.waitFor(() => expect(mocks.prefetchWorktreeCreateBase).toHaveBeenCalledOnce())
    expect(mocks.requestWorktreeCreateSpare).not.toHaveBeenCalled()
    finishRefresh('origin/main')
    await prefetch

    expect(mocks.requestWorktreeCreateSpare).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'repo-1' }),
      'origin/main',
      { seq: 1 }
    )
  })

  it('requests no spare when the refresh resolved no base', async () => {
    setPlatform('darwin')
    const runtime = new OrcaRuntimeService(makeStore() as never)

    await runtime.prefetchManagedWorktreeCreateBase({ repoSelector: 'repo-1' })

    expect(mocks.requestWorktreeCreateSpare).not.toHaveBeenCalled()
  })
})
