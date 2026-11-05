import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorktreeCreatePreparation from '../workspaces/creation/preparation/worktree-create-preparation'
import type { Project } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import { _resetWslCachesForTests, _setWslCachesForTests } from '../wsl/discovery/distro-catalog'

const mocks = vi.hoisted(() => ({
  prefetchWorktreeCreateBase: vi.fn(),
  prepareWorktreeCreateForRepo: vi.fn()
}))

vi.mock('../workspaces/creation/worktree-create-base-prefetch', () => ({
  prefetchWorktreeCreateBase: mocks.prefetchWorktreeCreateBase
}))
vi.mock(
  '../workspaces/creation/preparation/worktree-create-preparation',
  async (importOriginal) => ({
    ...(await importOriginal<typeof WorktreeCreatePreparation>()),
    prepareWorktreeCreateForRepo: mocks.prepareWorktreeCreateForRepo
  })
)

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
  mocks.prepareWorktreeCreateForRepo.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  setPlatform(hostPlatform)
  _resetWslCachesForTests()
})

// RPC prefetch must match IPC project routing; construct through the barrel for later selector subclasses.
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
})
