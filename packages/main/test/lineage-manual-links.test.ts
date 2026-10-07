import { describe, it, expect, vi } from 'vitest'
import type { LineageManualLink } from '../../../src/shared/lineage-discovery-types'
import {
  addLineageManualLink,
  removeLineageManualLink,
  type LineageManualLinkDeps
} from '../../../src/main/lineage/lineage-manual-links'
import type { LineageStoreContract } from '../../../src/main/lineage/workspace-lineage-service'
import type { GitWorktreeInfo } from '../../../src/shared/worktree/types'

const PARENT = 'worktree:r0::/o/tower'

function makeStore(initial: LineageManualLink[] = []) {
  let links = initial
  const store: LineageStoreContract = {
    getRepos: () => [
      { id: 'r1', path: '/r', displayName: 'loan-core' },
      { id: 'r2', path: '/remote/api', displayName: 'api', connectionId: 'ssh-1' },
      { id: 'f1', path: '/notes', displayName: 'notes', kind: 'folder' },
      { id: 'r3', path: '/r3', displayName: 'twin' },
      { id: 'r4', path: '/r4', displayName: 'twin' }
    ],
    getLineageManualLinks: () => links,
    setLineageManualLinks: (_key, next) => {
      links = next
    }
  }
  return { store, get: () => links }
}

const scan = async (repo: { path: string }): Promise<GitWorktreeInfo[]> => [
  { path: repo.path, head: 'h', branch: 'refs/heads/main', isBare: false, isMainWorktree: true },
  {
    path: `${repo.path}-wt/feat`,
    head: 'h',
    branch: 'refs/heads/feat',
    isBare: false,
    isMainWorktree: false
  }
]
const noLookup: LineageManualLinkDeps = {
  lookupPullRequestHeadBranch: async () => null,
  listRepoWorktrees: scan
}

describe('addLineageManualLink (legacy reference)', () => {
  it('stores a parsed link for a registered repo', async () => {
    const { store, get } = makeStore()
    const res = await addLineageManualLink(
      store,
      { parentWorkspaceKey: PARENT, reference: 'loan-core#12' },
      noLookup
    )
    expect(res.success).toBe(true)
    expect(res.link).toMatchObject({ kind: 'pr', repoName: 'loan-core', repoId: 'r1', number: 12 })
    expect(res.link?.id).toBeTruthy()
    expect(get()).toHaveLength(1)
  })
  it('rejects unparseable references', async () => {
    const { store, get } = makeStore()
    expect(
      await addLineageManualLink(store, { parentWorkspaceKey: PARENT, reference: 'nonsense' })
    ).toEqual({ success: false, error: 'Unrecognized pull request reference' })
    expect(get()).toEqual([])
  })
  it('rejects unregistered repos', async () => {
    const { store } = makeStore()
    expect(
      await addLineageManualLink(store, { parentWorkspaceKey: PARENT, reference: 'ghost#1' })
    ).toEqual({ success: false, error: 'Repository not registered in Orca' })
  })
  it('returns the existing link instead of duplicating, also for a legacy kind-less link', async () => {
    const { store, get } = makeStore([{ id: 'old', repoName: 'loan-core', number: 12, addedAt: 1 }])
    const lookup = vi.fn(async () => 'feat/x')
    const second = await addLineageManualLink(
      store,
      { parentWorkspaceKey: PARENT, reference: 'https://github.com/o/loan-core/pull/12' },
      { lookupPullRequestHeadBranch: lookup }
    )
    expect(second.success).toBe(true)
    expect(second.link?.id).toBe('old')
    expect(get()).toHaveLength(1)
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('addLineageManualLink (pr target)', () => {
  it('stores the head branch resolved once at add time', async () => {
    const { store } = makeStore()
    const lookup = vi.fn(async () => 'feature/LEVGP-1')
    const res = await addLineageManualLink(
      store,
      {
        parentWorkspaceKey: PARENT,
        target: { kind: 'pr', reference: 'https://gitlab.com/g/loan-core/-/merge_requests/4' }
      },
      { lookupPullRequestHeadBranch: lookup }
    )
    expect(res.link).toMatchObject({ kind: 'pr', number: 4, branch: 'feature/LEVGP-1' })
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }), {
      repoName: 'loan-core',
      number: 4,
      provider: 'gitlab',
      owner: 'g',
      host: 'gitlab.com'
    })
  })
  it('still adds the link when the branch lookup fails or finds nothing', async () => {
    for (const lookup of [
      async () => {
        throw new Error('gh down')
      },
      async () => null,
      async () => ''
    ]) {
      const { store, get } = makeStore()
      const res = await addLineageManualLink(
        store,
        { parentWorkspaceKey: PARENT, target: { kind: 'pr', reference: 'loan-core#3' } },
        { lookupPullRequestHeadBranch: lookup }
      )
      expect(res.success).toBe(true)
      expect(res.link?.branch).toBeUndefined()
      expect(get()).toHaveLength(1)
    }
  })
  it('does not store a duplicate added while the lookup was pending', async () => {
    const { store, get } = makeStore()
    let release: (branch: string) => void = () => {}
    const pending = new Promise<string>((resolve) => {
      release = resolve
    })
    const first = addLineageManualLink(
      store,
      { parentWorkspaceKey: PARENT, target: { kind: 'pr', reference: 'loan-core#3' } },
      { lookupPullRequestHeadBranch: () => pending }
    )
    const second = await addLineageManualLink(
      store,
      { parentWorkspaceKey: PARENT, reference: 'loan-core#3' },
      noLookup
    )
    release('b')
    const firstResult = await first
    expect(firstResult.link?.id).toBe(second.link?.id)
    expect(get()).toHaveLength(1)
  })
})

describe('addLineageManualLink (branch target)', () => {
  it('stores a branch of a registered repo, stripping refs/heads/', async () => {
    const { store, get } = makeStore()
    const res = await addLineageManualLink(store, {
      parentWorkspaceKey: PARENT,
      target: { kind: 'branch', repoId: 'r1', branch: 'refs/heads/feat/x' }
    })
    expect(res.link).toMatchObject({
      kind: 'branch',
      repoId: 'r1',
      repoName: 'loan-core',
      branch: 'feat/x'
    })
    const again = await addLineageManualLink(store, {
      parentWorkspaceKey: PARENT,
      target: { kind: 'branch', repoId: 'r1', branch: 'feat/x' }
    })
    expect(again.link?.id).toBe(res.link?.id)
    expect(get()).toHaveLength(1)
  })
  it('rejects unknown repos, folder projects and bad branch names', async () => {
    const { store, get } = makeStore()
    for (const target of [
      { kind: 'branch' as const, repoId: 'nope', branch: 'x' },
      { kind: 'branch' as const, repoId: 'f1', branch: 'x' },
      { kind: 'branch' as const, repoId: 'r1', branch: '' },
      { kind: 'branch' as const, repoId: 'r1', branch: 'x'.repeat(1025) }
    ]) {
      const res = await addLineageManualLink(store, { parentWorkspaceKey: PARENT, target })
      expect(res.success).toBe(false)
      expect(res.error).toBeTruthy()
    }
    expect(get()).toEqual([])
  })
})

describe('addLineageManualLink (worktree target)', () => {
  it('stores a known worktree of the repo with the store worktree id', async () => {
    const { store } = makeStore()
    const res = await addLineageManualLink(
      store,
      {
        parentWorkspaceKey: PARENT,
        target: { kind: 'worktree', repoId: 'r1', worktreePath: '/r-wt/feat/' }
      },
      noLookup
    )
    expect(res.link).toMatchObject({
      kind: 'worktree',
      repoId: 'r1',
      repoName: 'loan-core',
      worktreePath: '/r-wt/feat',
      worktreeId: 'r1::/r-wt/feat'
    })
  })
  it('accepts a remote (SSH) repo worktree without scanning it', async () => {
    const { store } = makeStore()
    const listRepoWorktrees = vi.fn(scan)
    const res = await addLineageManualLink(
      store,
      {
        parentWorkspaceKey: PARENT,
        target: { kind: 'worktree', repoId: 'r2', worktreePath: '/remote/api-wt/' }
      },
      { listRepoWorktrees }
    )
    expect(res.link).toMatchObject({ repoName: 'api', worktreeId: 'r2::/remote/api-wt' })
    expect(listRepoWorktrees).not.toHaveBeenCalled()
  })

  it('rejects a local path that is not one of the repo worktrees', async () => {
    const { store, get } = makeStore()
    expect(
      await addLineageManualLink(
        store,
        {
          parentWorkspaceKey: PARENT,
          target: { kind: 'worktree', repoId: 'r1', worktreePath: '/elsewhere' }
        },
        noLookup
      )
    ).toEqual({ success: false, error: 'Worktree is not part of this repository' })
    expect(get()).toEqual([])
  })

  it('treats a trailing slash as the same worktree', async () => {
    const { store, get } = makeStore()
    const target = { kind: 'worktree' as const, repoId: 'r1', worktreePath: '/r-wt/feat' }
    const first = await addLineageManualLink(
      store,
      { parentWorkspaceKey: PARENT, target },
      noLookup
    )
    const second = await addLineageManualLink(
      store,
      { parentWorkspaceKey: PARENT, target: { ...target, worktreePath: '/r-wt/feat/' } },
      noLookup
    )
    expect(second.link?.id).toBe(first.link?.id)
    expect(get()).toHaveLength(1)
  })
  it('rejects relative paths, unknown repos and oversized paths', async () => {
    const { store, get } = makeStore()
    for (const target of [
      { kind: 'worktree' as const, repoId: 'r1', worktreePath: 'relative/dir' },
      { kind: 'worktree' as const, repoId: 'nope', worktreePath: '/x' },
      { kind: 'worktree' as const, repoId: 'r1', worktreePath: `/${'x'.repeat(4096)}` }
    ]) {
      const res = await addLineageManualLink(
        store,
        { parentWorkspaceKey: PARENT, target },
        noLookup
      )
      expect(res.success).toBe(false)
    }
    expect(get()).toEqual([])
  })
})

describe('addLineageManualLink keys and errors', () => {
  it('keeps branch links of two registered repos that share a name apart', async () => {
    const { store, get } = makeStore()
    for (const repoId of ['r3', 'r4']) {
      await addLineageManualLink(store, {
        parentWorkspaceKey: PARENT,
        target: { kind: 'branch', repoId, branch: 'feat' }
      })
    }
    expect(get().map((link) => link.repoId)).toEqual(['r3', 'r4'])
  })

  it('reports an invalid parent workspace key for every target kind', async () => {
    const { store } = makeStore()
    for (const args of [
      { parentWorkspaceKey: '', reference: 'loan-core#1' },
      { parentWorkspaceKey: '', target: { kind: 'branch' as const, repoId: 'r1', branch: 'x' } },
      {
        parentWorkspaceKey: '',
        target: { kind: 'worktree' as const, repoId: 'r1', worktreePath: '/r' }
      }
    ]) {
      expect(await addLineageManualLink(store, args, noLookup)).toEqual({
        success: false,
        error: 'Invalid parent workspace key'
      })
    }
  })
})

describe('removeLineageManualLink', () => {
  it('removes by id', () => {
    const { store, get } = makeStore([{ id: 'a', repoName: 'loan-core', number: 1, addedAt: 1 }])
    expect(removeLineageManualLink(store, { parentWorkspaceKey: PARENT, linkId: 'a' })).toEqual({
      success: true
    })
    expect(get()).toEqual([])
  })
})
