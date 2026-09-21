import { describe, expect, it } from 'vitest'
import { getRepoOwnedWorktreeMeta } from './worktree-metadata-ownership'
import type { Repo } from '../shared/repo-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'

const worktreeId = 'repo-1::/workspace/feature'
const localRepo: Repo = {
  id: 'repo-1',
  path: '/workspace/repo',
  displayName: 'Local repo',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'local'
}
const sshRepo: Repo = {
  ...localRepo,
  path: '/workspace/repo',
  connectionId: 'build-box',
  executionHostId: 'ssh:build-box'
}
const localMeta = { hostId: 'local', displayName: 'local metadata' } as WorktreeMeta

function resolve(repo: Repo, ownerCount: number): WorktreeMeta | undefined {
  return getRepoOwnedWorktreeMeta(repo, worktreeId, { [worktreeId]: localMeta }, ownerCount)
}

describe('getRepoOwnedWorktreeMeta', () => {
  it('rejects another host metadata when repo IDs and paths collide', () => {
    expect(resolve(sshRepo, 2)).toBeUndefined()
  })

  it('keeps legacy metadata for a single-owner repo', () => {
    expect(resolve(localRepo, 1)).toBe(localMeta)
  })
})
