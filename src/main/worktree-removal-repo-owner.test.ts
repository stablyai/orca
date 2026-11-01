import { describe, expect, it } from 'vitest'
import {
  resolveWorktreeRemovalMetadata,
  resolveWorktreeRemovalRepoOwner
} from './worktree-removal-repo-owner'

import type { Repo } from '../shared/repo-types'

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: '/repos/shared',
    displayName: 'Shared',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  } as Repo
}

function makeStore(repos: readonly Repo[]): {
  getRepos: () => readonly Repo[]
  getRepo: (repoId: string) => Repo | undefined
} {
  return {
    getRepos: () => repos,
    getRepo: (repoId) => repos.find((repo) => repo.id === repoId)
  }
}

describe('resolveWorktreeRemovalRepoOwner', () => {
  const localRepo = makeRepo({ id: 'repo1' })
  const sshRepo = makeRepo({ id: 'repo1', connectionId: 'ssh-1' })

  it('fails closed when an unqualified request matches two hosts', () => {
    expect(resolveWorktreeRemovalRepoOwner(makeStore([localRepo, sshRepo]), 'repo1')).toEqual({
      kind: 'ambiguous'
    })
  })

  it('does not borrow destructive metadata from a colliding host', () => {
    const localMeta = { hostId: 'local', preserveBranchOnDelete: true }
    const metadataStore = {
      getRepos: () => [localRepo, sshRepo],
      getWorktreeMeta: () => localMeta
    }

    expect(
      resolveWorktreeRemovalMetadata(
        metadataStore as never,
        'repo1',
        'repo1::/shared/worktree',
        'ssh:ssh-1'
      )
    ).toBeUndefined()
    expect(
      resolveWorktreeRemovalMetadata(
        metadataStore as never,
        'repo1',
        'repo1::/shared/worktree',
        'local'
      )
    ).toBe(localMeta)
  })
})
