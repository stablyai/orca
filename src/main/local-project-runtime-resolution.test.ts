import { describe, expect, it } from 'vitest'
import type { Store } from './persistence'
import type { Project, Repo } from '../shared/types'
import { resolveLocalProjectDefaultShellForWorktreeId } from './local-project-runtime-resolution'

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

function makeStore(repo: Repo, project: Project): Store {
  return {
    getRepo: (id: string) => (id === repo.id ? repo : undefined),
    getProjects: () => [project],
    getSettings: () => ({})
  } as unknown as Store
}

describe('resolveLocalProjectDefaultShellForWorktreeId', () => {
  it('returns the project defaultShell for a local worktree', () => {
    const repo = makeRepo()
    const project = makeProject({ defaultShell: 'git-bash' })
    expect(resolveLocalProjectDefaultShellForWorktreeId(makeStore(repo, project), 'repo-1')).toBe(
      'git-bash'
    )
  })

  it('returns undefined when the project has no defaultShell override', () => {
    const repo = makeRepo()
    const project = makeProject()
    expect(
      resolveLocalProjectDefaultShellForWorktreeId(makeStore(repo, project), 'repo-1')
    ).toBeUndefined()
  })

  it('normalizes a legacy/invalid persisted defaultShell to inherit on read', () => {
    const repo = makeRepo()
    // A hand-edited or legacy persisted value bypasses the write-path normalizer.
    const project = makeProject({ defaultShell: 'bogus-shell' as never })
    expect(resolveLocalProjectDefaultShellForWorktreeId(makeStore(repo, project), 'repo-1')).toBe(
      'inherit'
    )
  })

  it('does not apply project defaultShell to SSH-owned repos', () => {
    const repo = makeRepo({ connectionId: null, executionHostId: 'ssh:target-1' })
    const project = makeProject({ defaultShell: 'git-bash' })
    expect(
      resolveLocalProjectDefaultShellForWorktreeId(makeStore(repo, project), 'repo-1')
    ).toBeUndefined()
  })

  it('returns undefined without a store or worktreeId', () => {
    const repo = makeRepo()
    const project = makeProject({ defaultShell: 'git-bash' })
    expect(resolveLocalProjectDefaultShellForWorktreeId(undefined, 'repo-1')).toBeUndefined()
    expect(
      resolveLocalProjectDefaultShellForWorktreeId(makeStore(repo, project), undefined)
    ).toBeUndefined()
  })
})
