import { vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import { normalizeGitRemoteUrl, type GitRemoteIdentity } from '../shared/git-remote-identity'
import { projectHostSetupProjectionFromRepos } from '../shared/project-host-setup-projection'
import type { Repo, RepoProjectHostSetupMethod, WorktreeMeta } from '../shared/types'
import {
  reconcileExistingFolderProjectIdentity,
  type ExistingFolderReconciliationStore
} from './project-host-existing-folder-reconciliation'
import { probeGitRemoteIdentity } from './repo-git-remote-identity'

// Shared by the reconciliation specs, which split by concern (policy vs host routing) and
// need the same projection-backed store fake and canonical-key fixtures.

export const NOW = 1_700_000_000_000
export const TEAM_SCP_URL = 'git@gitlab.example.com:team/orca.git'
export const TEAM_SSH_URL = 'ssh://git@gitlab.example.com/team/orca.git'
export const FORK_URL = 'git@gitlab.example.com:ava/orca.git'
export const OTHER_URL = 'git@gitlab.example.com:other/orca.git'
export const GHES_URL = 'git@git.acme-corp.com:acme/orca.git'
export const GHES_OTHER_URL = 'git@git.acme-corp.com:other/orca.git'
export const GITHUB_URL = 'git@github.com:acme/orca.git'
export const GITHUB_SSH_ALIAS_URL = 'git@ssh.github.com:acme/orca.git'

export const TEAM_PROJECT_ID = 'git:gitlab.example.com/team/orca'
export const FORK_PROJECT_ID = 'git:gitlab.example.com/ava/orca'
export const GHES_PROJECT_ID = 'github:git.acme-corp.com/acme/orca'

/** Derives the canonical key the way the probe does, so URL-shape equivalence is real. */
export function identity(remoteName: string, remoteUrl: string): GitRemoteIdentity {
  const canonicalKey = normalizeGitRemoteUrl(remoteUrl)
  if (!canonicalKey) {
    throw new Error(`unusable remote url in fixture: ${remoteUrl}`)
  }
  return { canonicalKey, remoteName, remoteUrl }
}

export const teamIdentity = identity('origin', TEAM_SCP_URL)
export const forkIdentity = identity('origin', FORK_URL)
export const otherIdentity = identity('origin', OTHER_URL)
export const ghesIdentity = identity('origin', GHES_URL)

export function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-imported',
    path: '/work/orca',
    displayName: 'orca',
    badgeColor: '#737373',
    addedAt: NOW,
    kind: 'git',
    ...overrides
  }
}

export type FakeStore = ExistingFolderReconciliationStore & {
  updateRepo: ReturnType<typeof vi.fn>
  restoreRepoIdentityFields: ReturnType<typeof vi.fn>
  setWorktreeMeta: ReturnType<typeof vi.fn>
  worktreeMeta: Record<string, WorktreeMeta>
}

export function makeWorktreeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: NOW,
    ...overrides
  }
}

export function makeStore(
  repos: Repo[],
  /** Stands in for the real store's persistence sanitizers, which can keep less than
   *  the caller asked for. */
  sanitize: (updates: Partial<Repo>) => Partial<Repo> = (updates) => updates,
  worktreeMeta: Record<string, WorktreeMeta> = {}
): FakeStore {
  return {
    worktreeMeta,
    getAllWorktreeMeta: () => worktreeMeta,
    setWorktreeMeta: vi.fn((worktreeId: string, meta: Partial<WorktreeMeta>) => {
      const updated = { ...(worktreeMeta[worktreeId] ?? makeWorktreeMeta()), ...meta }
      worktreeMeta[worktreeId] = updated
      return updated
    }),
    // The real store re-projects repo-backed setups on every read, so projecting here
    // keeps the fake faithful to what a write actually changes.
    getProjects: () => projectHostSetupProjectionFromRepos(repos, NOW).projects,
    getProjectHostSetups: () => projectHostSetupProjectionFromRepos(repos, NOW).setups,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    updateRepo: vi.fn((id: string, updates: Partial<Repo>) => {
      const target = repos.find((repo) => repo.id === id)
      if (!target) {
        return null
      }
      Object.assign(target, sanitize(updates))
      return { ...target }
    }),
    // Mirrors `Store.restoreRepoIdentityFields`: a present key holding `undefined`
    // clears the field, which `updateRepo` cannot express.
    restoreRepoIdentityFields: vi.fn(
      (id: string, restore: Pick<Partial<Repo>, 'upstream' | 'gitRemoteIdentity'>) => {
        const target = repos.find((repo) => repo.id === id)
        if (!target) {
          return null
        }
        for (const field of ['upstream', 'gitRemoteIdentity'] as const) {
          if (!(field in restore)) {
            continue
          }
          if (restore[field] === undefined) {
            delete target[field]
          } else {
            Object.assign(target, { [field]: restore[field] })
          }
        }
        return { ...target }
      }
    )
  }
}

export function reconcile(
  store: ExistingFolderReconciliationStore,
  repo: Repo,
  projectId: string,
  options: { ownedExecutionHostId?: ExecutionHostId; setupMethod?: RepoProjectHostSetupMethod } = {}
) {
  return reconcileExistingFolderProjectIdentity({
    store,
    repo,
    projectId,
    ownedExecutionHostId: options.ownedExecutionHostId ?? LOCAL_EXECUTION_HOST_ID,
    ...(options.setupMethod ? { setupMethod: options.setupMethod } : {})
  })
}

export function mockResolved(...remotes: GitRemoteIdentity[]): void {
  const primary = remotes[0]
  if (!primary) {
    throw new Error('mockResolved needs at least one remote')
  }
  vi.mocked(probeGitRemoteIdentity).mockResolvedValue({
    status: 'resolved',
    identity: primary,
    remotes
  })
}
