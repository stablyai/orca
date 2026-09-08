import { beforeEach, expect, it, vi } from 'vitest'
import { reviewTarget } from '../../shared/__fixtures__/git-review-target'
import type { Store } from '../persistence'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const { canonical, catalog } = vi.hoisted(() => ({ canonical: vi.fn(), catalog: vi.fn() }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: () => ({ realpath: canonical })
}))
vi.mock('../local-worktree-filesystem', () => ({
  getLocalWorktreePathAccess: () => ({ realpath: canonical })
}))
vi.mock('../repo-worktrees', () => ({ listRepoWorktreesForDetectedScan: catalog }))
import {
  resolveReviewPushWorkspace,
  resolveStoredReviewPushTarget
} from './worktree-review-push-target'

beforeEach(() => {
  canonical.mockReset().mockImplementation(async (path: string) => {
    if (['/repo/wt', '/repo/wt/.', '/repo/wt/', '/symlink', '/REPO/WT'].includes(path)) {
      return '/repo/wt'
    }
    return path
  })
  catalog.mockReset().mockResolvedValue([{ path: '/repo/wt' }])
})

function fixture(meta: Partial<WorktreeMeta> | undefined, connectionId?: string) {
  const entries: Record<string, Partial<WorktreeMeta>> = meta ? { 'repo::/repo/wt': meta } : {}
  const store = {
    getRepos: () => [{ id: 'repo', path: '/repo', connectionId }],
    getAllWorktreeMetaForHost: vi.fn(() => entries),
    getWorktreeMetaForHost: vi.fn((id: string) => entries[id])
  } as unknown as Store
  return { store, entries }
}

for (const connectionId of [undefined, 'ssh-fixture']) {
  for (const path of ['/repo/wt', '/repo/wt/.', '/repo/wt/', '/symlink', '/REPO/WT']) {
    it(`retains queued authority for ${connectionId ?? 'local'} host-canonical ${path}`, async () => {
      const target = reviewTarget('origin', 'feature')
      const { store } = fixture({ pushTarget: target }, connectionId)
      expect(
        await resolveReviewPushWorkspace(store, { worktreePath: path, connectionId })
      ).toMatchObject({ worktreePath: '/repo/wt', pushTarget: target })
      expect(canonical).toHaveBeenCalledWith(path)
      expect(store.getAllWorktreeMetaForHost).toHaveBeenCalledWith(
        connectionId ? `ssh:${connectionId}` : 'local'
      )
    })
  }
  for (const link of [{ linkedPR: 42 }, { linkedGitLabMR: 42 }]) {
    it(`rejects unresolved ${JSON.stringify(link)} via ${connectionId ?? 'local'} alias`, async () => {
      const { store } = fixture(link, connectionId)
      await expect(
        resolveStoredReviewPushTarget(store, { worktreePath: '/repo/wt/.', connectionId })
      ).rejects.toThrow('unresolved')
    })
  }
  it(`rejects stale explicit target via ${connectionId ?? 'local'} alias`, async () => {
    const { store } = fixture({ pushTarget: reviewTarget('origin', 'feature') }, connectionId)
    await expect(
      resolveStoredReviewPushTarget(store, {
        worktreePath: '/symlink',
        connectionId,
        pushTarget: reviewTarget('other', 'feature')
      })
    ).rejects.toThrow('changed')
  })
  it(`allows positively registered unlinked ${connectionId ?? 'local'} workspace`, async () => {
    const { store } = fixture(undefined, connectionId)
    expect(
      await resolveStoredReviewPushTarget(store, { worktreePath: '/symlink', connectionId })
    ).toBeUndefined()
    expect(catalog).toHaveBeenCalledTimes(1)
  })
  it(`does not turn failed ${connectionId ?? 'local'} host identity into unlinked work`, async () => {
    const { store } = fixture(undefined, connectionId)
    canonical.mockRejectedValue(new Error('host unavailable'))
    await expect(
      resolveStoredReviewPushTarget(store, { worktreePath: '/symlink', connectionId })
    ).rejects.toThrow('host unavailable')
    expect(catalog).not.toHaveBeenCalled()
  })
}

it('rejects unknown and ambiguous owners and an explicit id for another path', async () => {
  const { store, entries } = fixture(undefined, 'ssh-fixture')
  catalog.mockResolvedValue([])
  await expect(
    resolveReviewPushWorkspace(store, { worktreePath: '/repo/wt', connectionId: 'ssh-fixture' })
  ).rejects.toThrow('unverifiable')
  entries['repo::/repo/wt'] = { pushTarget: reviewTarget('origin', 'feature') }
  entries['repo::/symlink'] = { linkedPR: 42 }
  await expect(
    resolveReviewPushWorkspace(store, { worktreePath: '/repo/wt', connectionId: 'ssh-fixture' })
  ).rejects.toThrow('ambiguous')
  await expect(
    resolveReviewPushWorkspace(store, {
      worktreePath: '/repo/wt',
      worktreeId: 'repo::/other',
      connectionId: 'ssh-fixture'
    })
  ).rejects.toThrow('unverifiable')
})

it('rereads policy after asynchronous canonical identity resolution', async () => {
  const { store, entries } = fixture(
    { pushTarget: reviewTarget('origin', 'feature') },
    'ssh-fixture'
  )
  canonical.mockImplementation(async () => {
    entries['repo::/repo/wt'] = { linkedPR: 42 }
    return '/repo/wt'
  })
  await expect(
    resolveStoredReviewPushTarget(store, { worktreePath: '/symlink', connectionId: 'ssh-fixture' })
  ).rejects.toThrow('unresolved')
})
