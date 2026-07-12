import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../shared/constants'
import type { PersistedState, Project, Repo } from '../../shared/types'
import { projectHostSetupProjectionFromRepos } from '../../shared/project-host-setup-projection'
import { rebuildRepoBackedProjectState } from './profile-project-state-file'

// A repo whose git remote identity makes its projected project id `git:<key>`
// (non-GitHub canonicalKey so no provider-identity shortcut fires).
function makeGitRemoteRepo(): Repo {
  return {
    id: 'repo-1',
    path: '\\\\wsl.localhost\\Ubuntu\\home\\j\\app',
    displayName: 'app',
    badgeColor: '#000000',
    addedAt: 100,
    kind: 'git',
    connectionId: null,
    gitRemoteIdentity: {
      canonicalKey: 'gitlab.com/acme/app',
      remoteName: 'origin',
      remoteUrl: 'https://gitlab.com/acme/app.git'
    }
  }
}

function stateWith(repo: Repo, predecessor: Project): PersistedState {
  return {
    ...getDefaultPersistedState('/home/j'),
    repos: [repo],
    // The predecessor project is keyed by the pre-enrichment `repo:<id>` id, so
    // an id-keyed lookup against the freshly projected `git:<key>` id misses it.
    projects: [predecessor],
    projectHostSetups: []
  }
}

describe('rebuildRepoBackedProjectState — predecessor recovery', () => {
  it('migrates project-scoped settings when the owning project id shifted', () => {
    const repo = makeGitRemoteRepo()
    const projectedId = projectHostSetupProjectionFromRepos([repo]).projects[0]!.id
    expect(projectedId).toBe('git:gitlab.com/acme/app')

    const predecessor: Project = {
      id: 'repo:repo-1',
      displayName: 'app',
      badgeColor: '#000000',
      sourceRepoIds: ['repo-1'],
      createdAt: 100,
      updatedAt: 100,
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
      defaultShell: 'git-bash'
    }

    const rebuilt = rebuildRepoBackedProjectState(stateWith(repo, predecessor))
    const project = rebuilt.projects.find((p) => p.id === projectedId)
    expect(project?.localWindowsRuntimePreference).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    expect(project?.defaultShell).toBe('git-bash')
  })
})
