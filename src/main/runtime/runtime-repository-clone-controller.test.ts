import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { RuntimeStore } from './runtime-store-contract'
import { RuntimeRepositoryCloneController } from './runtime-repository-clone-controller'

const repoAt = (path: string): Repo => ({
  id: `repo-${path}`,
  path,
  displayName: path.split('/').pop() ?? path,
  badgeColor: '#aabbcc',
  addedAt: 0,
  kind: 'git'
})

// Type-correct filler: no test below reaches the work that would write meta.
const emptyWorktreeMeta = (): WorktreeMeta => ({
  displayName: '',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
})

// Minimal RuntimeStore: the clone controller reads repos and settings only until
// the clone succeeds, and every test below returns from the idempotency check.
const makeStore = (repos: Repo[], workspaceDir: string): RuntimeStore => ({
  getRepos: () => repos,
  getRepo: () => undefined,
  addRepo: () => {},
  updateRepo: () => null,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  setWorktreeMeta: () => emptyWorktreeMeta(),
  removeWorktreeMeta: () => {},
  getGitHubCache: () => ({ pr: {}, issue: {} }),
  getSettings: () => ({
    workspaceDir,
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: '',
    branchPrefixCustom: ''
  })
})

const makeController = (repos: Repo[], workspaceDir: string): RuntimeRepositoryCloneController =>
  new RuntimeRepositoryCloneController({
    getStore: () => makeStore(repos, workspaceDir),
    invalidateResolvedWorktrees: () => {},
    invalidateWorktreeScan: () => {},
    notifyReposChanged: () => {}
  })

describe('RuntimeRepositoryCloneController default destination', () => {
  // Every case proves the resolved destination through the idempotency-by-path
  // hit: the controller returns the existing row only when the clone path it
  // derived (destination + repo name from the URL) matches that row.

  it('derives the destination from the workspace directory when absent', async () => {
    const existing = repoAt('/home/li/orca/example-repo')
    const controller = makeController([existing], '/home/li/orca/workspaces')

    await expect(
      controller.clone('https://github.com/example/example-repo.git', undefined)
    ).resolves.toBe(existing)
  })

  it('treats a blank destination as absent', async () => {
    const existing = repoAt('/home/li/orca/example-repo')
    const controller = makeController([existing], '/home/li/orca/workspaces')

    await expect(
      controller.clone('https://github.com/example/example-repo.git', '   ')
    ).resolves.toBe(existing)
  })

  it('falls back to the home projects directory without a usable workspace directory', async () => {
    const existing = repoAt(join(homedir(), 'orca', 'projects', 'example-repo'))
    const controller = makeController([existing], '')

    await expect(
      controller.clone('https://github.com/example/example-repo.git', undefined)
    ).resolves.toBe(existing)
  })

  it('honors an explicit destination over the default', async () => {
    const defaultRow = repoAt('/home/li/orca/example-repo')
    const explicitRow = repoAt('/srv/custom/example-repo')
    const controller = makeController([defaultRow, explicitRow], '/home/li/orca/workspaces')

    await expect(
      controller.clone('https://github.com/example/example-repo.git', '/srv/custom')
    ).resolves.toBe(explicitRow)
  })
})
