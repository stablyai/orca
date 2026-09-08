import { beforeEach, expect, it, vi } from 'vitest'
import { reviewTarget } from '../../shared/__fixtures__/git-review-target'
import type { Store } from '../persistence'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Repo } from '../../shared/repo-types'

const { canonical, catalog, localAccess, options } = vi.hoisted(() => ({
  canonical: vi.fn(),
  catalog: vi.fn(),
  localAccess: vi.fn(),
  options: vi.fn()
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: () => ({ realpath: canonical })
}))
vi.mock('../local-worktree-filesystem', () => ({ getLocalWorktreePathAccess: localAccess }))
vi.mock('../repo-worktrees', () => ({ listRepoWorktreesForDetectedScan: catalog }))
vi.mock('./local-worktree-runtime-options', () => ({ getLocalGitOptionsForRepo: options }))
import { resolveReviewPushWorkspace } from './worktree-review-push-target'

beforeEach(() => {
  canonical
    .mockReset()
    .mockImplementation(async (path: string) => (path === '/alias' ? '/good/wt' : path))
  catalog.mockReset().mockResolvedValue([])
  localAccess.mockReset().mockImplementation(() => ({ realpath: canonical }))
  options.mockReset().mockReturnValue({})
})
function fixture(connectionId?: string) {
  const entries: Record<string, Partial<WorktreeMeta>> = {
    'good::/good/wt': { pushTarget: reviewTarget('origin', 'feature') }
  }
  const repos = [{ id: 'good', path: '/good', connectionId }] as Repo[]
  const all = vi.fn(() => entries)
  const single = vi.fn((id: string) => entries[id])
  const store = {
    getRepos: () => repos,
    getAllWorktreeMetaForHost: all,
    getWorktreeMetaForHost: single
  } as unknown as Store
  const args = { worktreePath: '/alias', worktreeId: 'good::/good/wt', connectionId }
  return { entries, repos, store, args, all, single }
}
for (const connectionId of [undefined, 'ssh-fixture']) {
  for (const stale of [
    { linkedPR: 42 },
    { linkedGitLabMR: 42 },
    { pushTarget: reviewTarget('origin', 'stale') }
  ]) {
    it(`ignores unrelated removed policy ${JSON.stringify(stale)} on ${connectionId ?? 'local'}`, async () => {
      const { entries, store, args, all, single } = fixture(connectionId)
      entries['good::/removed'] = stale
      canonical.mockImplementation(async (path: string) => {
        if (path === '/removed') {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        return '/good/wt'
      })
      await expect(resolveReviewPushWorkspace(store, args)).resolves.toMatchObject({
        pushTarget: entries[args.worktreeId].pushTarget
      })
      expect(canonical.mock.calls.map(([path]) => path)).toEqual(['/good/wt', '/alias'])
      expect(catalog).not.toHaveBeenCalled()
      expect(all).not.toHaveBeenCalled()
      expect(single.mock.calls.every(([id]) => id === args.worktreeId)).toBe(true)
    })
  }
  it(`does not depend on unrelated catalog availability on ${connectionId ?? 'local'}`, async () => {
    const { store, repos, args } = fixture(connectionId)
    repos.push({ id: 'unrelated', path: '/unmounted', connectionId } as Repo)
    catalog.mockRejectedValue(new Error('unrelated catalog unavailable'))
    await expect(resolveReviewPushWorkspace(store, args)).resolves.toMatchObject({
      worktreePath: '/good/wt'
    })
    expect(catalog).not.toHaveBeenCalled()
  })
  it(`keeps requested unavailable owner unverifiable on ${connectionId ?? 'local'}`, async () => {
    const { store, args } = fixture(connectionId)
    canonical.mockRejectedValue(new Error('owner host unavailable'))
    await expect(resolveReviewPushWorkspace(store, args)).rejects.toThrow('owner host unavailable')
    expect(catalog).not.toHaveBeenCalled()
  })
  it(`corroborates unlinked registration only in requested catalog on ${connectionId ?? 'local'}`, async () => {
    const { entries, store, repos, args } = fixture(connectionId)
    delete entries[args.worktreeId]
    repos.push({ id: 'unrelated', path: '/unmounted', connectionId } as Repo)
    catalog.mockResolvedValue([{ path: '/good/wt' }, { path: '/removed' }])
    await expect(resolveReviewPushWorkspace(store, args)).resolves.toMatchObject({
      pushTarget: undefined
    })
    expect(catalog).toHaveBeenCalledExactlyOnceWith(repos[0], {})
    expect(canonical).toHaveBeenCalledTimes(2)
    catalog.mockRejectedValue(new Error('owner catalog unavailable'))
    await expect(resolveReviewPushWorkspace(store, args)).rejects.toThrow(
      'owner catalog unavailable'
    )
  })
  for (const policy of [{ linkedPR: 42 }, { linkedGitLabMR: 42 }]) {
    it(`rereads requested ${JSON.stringify(policy)} after realpath on ${connectionId ?? 'local'}`, async () => {
      const { entries, store, args } = fixture(connectionId)
      canonical.mockImplementation(async () => {
        entries[args.worktreeId] = policy
        return '/good/wt'
      })
      await expect(resolveReviewPushWorkspace(store, args)).rejects.toThrow('unresolved')
    })
  }
  it(`rejects stale explicit target and removed policy on ${connectionId ?? 'local'}`, async () => {
    const { entries, store, args } = fixture(connectionId)
    await expect(
      resolveReviewPushWorkspace(store, { ...args, pushTarget: reviewTarget('other', 'feature') })
    ).rejects.toThrow('changed')
    canonical.mockImplementation(async () => {
      delete entries[args.worktreeId]
      return '/good/wt'
    })
    await expect(resolveReviewPushWorkspace(store, args)).rejects.toThrow('metadata changed')
  })
}
for (const dimension of ['repos', 'metadata']) {
  it(`explicit owner avoids global ${dimension} admission bound`, async () => {
    const { store, repos, entries, args, all } = fixture()
    if (dimension === 'repos') {
      for (let i = 0; i < 128; i++) {
        repos.push({ id: `unrelated${i}`, path: `/unrelated${i}` } as Repo)
      }
    } else {
      for (let i = 0; i < 512; i++) {
        entries[`good::/removed${i}`] = { linkedPR: 42 }
      }
    }
    await expect(resolveReviewPushWorkspace(store, args)).resolves.toMatchObject({
      worktreePath: '/good/wt'
    })
    expect(catalog).not.toHaveBeenCalled()
    expect(all).not.toHaveBeenCalled()
    expect(canonical).toHaveBeenCalledTimes(2)
  })
}
it('does two owner realpaths and zero catalogs with ten unrelated repositories', async () => {
  const { store, repos, args } = fixture('ssh-fixture')
  for (let i = 0; i < 10; i++) {
    repos.push({ id: `unrelated${i}`, path: `/unrelated${i}`, connectionId: 'ssh-fixture' } as Repo)
  }
  await resolveReviewPushWorkspace(store, args)
  expect(canonical).toHaveBeenCalledTimes(2)
  expect(catalog).not.toHaveBeenCalled()
})
it('uses only the selected same-host WSL distro even when paths collide', async () => {
  const { store, repos, args } = fixture()
  repos.unshift({ id: 'other', path: '/good', connectionId: undefined } as Repo)
  options.mockImplementation((_store, repo: Repo) => ({
    wslDistro: repo.id === 'good' ? 'Ubuntu' : 'Debian'
  }))
  localAccess.mockImplementation(({ wslDistro }) => {
    if (wslDistro !== 'Ubuntu') {
      throw new Error('unrelated distro unavailable')
    }
    return { realpath: canonical }
  })
  await expect(resolveReviewPushWorkspace(store, args)).resolves.toMatchObject({
    gitOptions: { wslDistro: 'Ubuntu' }
  })
  expect(localAccess).toHaveBeenCalledExactlyOnceWith({ wslDistro: 'Ubuntu' })
})
it('rejects wrong-host owners and unregistered IDs before accepting their path', async () => {
  const { store, repos, args, entries } = fixture()
  repos[0].connectionId = 'elsewhere'
  await expect(resolveReviewPushWorkspace(store, args)).rejects.toThrow('unverifiable')
  expect(canonical).not.toHaveBeenCalled()
  repos[0].connectionId = undefined
  delete entries[args.worktreeId]
  await expect(resolveReviewPushWorkspace(store, args)).rejects.toThrow('unverifiable')
})
it('retains explicit folder instance identity without putting its suffix in realpath', async () => {
  const { entries, store, args } = fixture()
  const id = 'good::/good/wt::workspace:11111111-1111-1111-1111-111111111111'
  entries[id] = entries[args.worktreeId]
  await expect(
    resolveReviewPushWorkspace(store, { ...args, worktreeId: id })
  ).resolves.toMatchObject({ worktreePath: '/good/wt' })
  expect(canonical.mock.calls.map(([path]) => path)).toEqual(['/good/wt', '/alias'])
})
