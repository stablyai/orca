import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState, Project, Repo } from '../../shared/types'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import { applyPayloadToTarget, createTransferPayload } from './profile-project-transfer-payload'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '\\\\wsl.localhost\\Ubuntu\\home\\j\\app',
    displayName: 'app',
    badgeColor: '#000000',
    addedAt: 100,
    kind: 'git',
    connectionId: null,
    ...overrides
  }
}

// Build a source profile whose owning project carries the project-scoped
// settings a WSL transfer must preserve.
function sourceStateWith(repo: Repo, projectOverrides: Partial<Project>): PersistedState {
  const projection = projectHostSetupProjectionFromRepos([repo])
  return {
    ...getDefaultPersistedState('/home/j'),
    repos: [repo],
    projects: [{ ...projection.projects[0], ...projectOverrides }],
    projectHostSetups: projection.setups
  }
}

function targetProjectIdFor(repo: Repo): string {
  const projection = projectHostSetupProjectionFromRepos([repo])
  return projection.setups[0]?.projectId ?? projection.projects[0]!.id
}

describe('profile project transfer payload — project-scoped settings', () => {
  it('carries localWindowsRuntimePreference and defaultShell onto the target project', () => {
    const sourceRepo = makeRepo()
    const sourceState = sourceStateWith(sourceRepo, {
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
      defaultShell: 'git-bash'
    })
    const targetRepo = makeRepo({ id: 'repo-2', addedAt: 200 })

    const payload = createTransferPayload({
      sourceState,
      sourceRepo,
      targetRepo,
      includeSessions: false
    })
    expect(payload.localWindowsRuntimePreference).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    expect(payload.defaultShell).toBe('git-bash')

    const applied = applyPayloadToTarget(getDefaultPersistedState('/home/j'), payload)
    const targetProject = applied.projects.find((p) => p.id === targetProjectIdFor(targetRepo))
    expect(targetProject?.localWindowsRuntimePreference).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    expect(targetProject?.defaultShell).toBe('git-bash')
  })

  it('does not add project-scoped settings for a plain (non-WSL) transfer', () => {
    const sourceRepo = makeRepo({ path: '/workspace/orca' })
    const sourceState = sourceStateWith(sourceRepo, {})
    const targetRepo = makeRepo({ id: 'repo-2', path: '/workspace/orca-2', addedAt: 200 })

    const payload = createTransferPayload({
      sourceState,
      sourceRepo,
      targetRepo,
      includeSessions: false
    })
    expect(payload.localWindowsRuntimePreference).toBeUndefined()
    expect(payload.defaultShell).toBeUndefined()

    const applied = applyPayloadToTarget(getDefaultPersistedState('/home/j'), payload)
    const targetProject = applied.projects.find((p) => p.id === targetProjectIdFor(targetRepo))
    expect(targetProject).toBeDefined()
    expect(targetProject?.localWindowsRuntimePreference).toBeUndefined()
    expect(targetProject?.defaultShell).toBeUndefined()
  })
})
