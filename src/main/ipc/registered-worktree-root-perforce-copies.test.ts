import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { RegisteredWorktreeRootStore } from './registered-worktree-root-store'

vi.mock('../repo-worktrees', () => ({ listRepoWorktreeGraph: vi.fn(async () => []) }))
vi.mock('../local-project-runtime-resolution', () => ({
  resolveLocalProjectRuntimesForRepos: () => new Map()
}))
import { listWorktreeRootsWithConcurrency } from './registered-worktree-root-probes'

const repo: Repo = {
  id: 'p4-project',
  path: 'C:\\ws\\game',
  displayName: 'game',
  badgeColor: '#000',
  addedAt: 0,
  kind: 'folder'
}
const copyPath = 'C:\\ws.wt\\copy-1\\game'
const copyId = `${repo.id}::${copyPath}`
const baseMeta: WorktreeMeta = {
  displayName: 'copy-1',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

function storeWith(meta: Record<string, WorktreeMeta>): RegisteredWorktreeRootStore {
  return {
    getRepos: () => [repo],
    getProjects: () => [],
    getSettings: () => ({}),
    getAllWorktreeMeta: () => meta
  }
}

describe('Perforce copy roots', () => {
  beforeEach(() => vi.clearAllMocks())

  it('authorizes a copy that main recorded', async () => {
    const [listed] = await listWorktreeRootsWithConcurrency(
      storeWith({ [copyId]: { ...baseMeta, orcaCreatedAt: 1, orcaCreationSource: 'desktop' } }),
      [repo]
    )
    expect(listed.roots.has(resolve(copyPath))).toBe(true)
  })

  it('ignores a copy-shaped id without Orca creation provenance', async () => {
    const [listed] = await listWorktreeRootsWithConcurrency(storeWith({ [copyId]: baseMeta }), [
      repo
    ])
    expect(listed.roots.has(resolve(copyPath))).toBe(false)
  })
})
