import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from './persistence'
import type { Project } from '../shared/project-types'
import type { Repo } from '../shared/repo-types'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../shared/wsl-host-internal-gate'
import { getProjectRuntimeReadGitOptions } from './project-runtime-git-options'
import { _resetWslCachesForTests, _setWslCachesForTests } from './wsl'

const repo: Repo = {
  id: 'repo-1',
  displayName: 'Repo',
  path: String.raw`C:\repo`,
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

function store(experimentalWslHosts: boolean): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: runtime resolution reads only getProjects and getSettings.
  return {
    getProjects: () => [project],
    getSettings: () => ({
      localWindowsRuntimeDefault: { kind: 'windows-host' },
      experimentalWslHosts
    })
  } as unknown as Store
}

// Stage 1 is opt-in: base-ref and remote-identity reads follow the runtime only with the setting on.
describe('base-ref and remote-identity reads of a WSL-runtime project', () => {
  const platform = process.platform
  beforeEach(() => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    _setWslCachesForTests({ available: true, distros: ['Ubuntu'] })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    _resetWslCachesForTests()
  })

  it('run with host Git as before while the WSL hosts setting is off', () => {
    expect(getProjectRuntimeReadGitOptions(store(false), repo)).toEqual({})
  })

  it("follow the project's distro once the user turns WSL hosts on", () => {
    expect(getProjectRuntimeReadGitOptions(store(true), repo)).toEqual({ wslDistro: 'Ubuntu' })
  })
})
