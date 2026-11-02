import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'

const { visibleRepos } = vi.hoisted(() => ({
  visibleRepos:
    vi.fn<(store: { getRepos: () => Repo[]; getSshTargets: () => unknown[] }) => Repo[]>()
}))
vi.mock('../ssh/orcad-retained-source', () => ({
  visibleRepos,
  visibleProjectGroups: vi.fn(() => []),
  visibleFolderWorkspaces: vi.fn(() => [])
}))

const { runtimeHiddenHostIds, runtimeHiddenRepos } = await import('./runtime-visible-catalog')

const sshTarget = { id: 'target-1', label: 'dev', host: 'dev', port: 22, username: 'dev' }
const repo = (id: string, connectionId?: string): Repo => ({
  id,
  ...(connectionId ? { connectionId } : {}),
  path: `/src/${id}`,
  displayName: id,
  badgeColor: '#000',
  addedAt: 0
})
const storeWith = (repos: Repo[], withTargets: boolean) => ({
  getRepos: () => repos,
  ...(withTargets ? { getSshTargets: () => [sshTarget] } : {})
})

describe('runtime visible catalog', () => {
  it('hides a moved local row by host while the WSL host row with the same id stays listed', () => {
    const local = repo('moved')
    const onHost: Repo = { ...repo('moved'), executionHostId: 'runtime:wsl-ubuntu' }
    visibleRepos.mockImplementation((store) => store.getRepos().filter((r) => r !== local))
    const hidden = runtimeHiddenRepos(storeWith([local, onHost], true))
    expect(hidden.size).toBe(1)
    expect(hidden.hasRepo(local)).toBe(true)
    expect(hidden.hasRepo(onHost)).toBe(false)
    expect(hidden.hasWorktree({ repoId: 'moved', hostId: 'local' })).toBe(true)
    expect(hidden.hasWorktree({ repoId: 'moved', hostId: 'runtime:wsl-ubuntu' })).toBe(false)
  })

  it('keeps a host that still has a visible row', () => {
    visibleRepos.mockImplementation((store) => store.getRepos().filter((r) => r.id !== 'a'))
    const store = storeWith([repo('a', 'target-2'), repo('b', 'target-2')], true)
    expect(runtimeHiddenHostIds(store).size).toBe(0)
  })

  describe('a repo id shared by a visible host and a retained SSH source', () => {
    const local = repo('same-project')
    const retained = repo('same-project', 'target-1')
    const store = storeWith([local, retained], true)
    // Same id on both rows: only the SSH row is the retired source.
    const hideRetained = (s: { getRepos: () => Repo[] }): Repo[] =>
      s.getRepos().filter((r) => r.connectionId !== 'target-1')

    it('still names the retired SSH host as hidden', () => {
      visibleRepos.mockImplementation(hideRetained)
      expect([...runtimeHiddenHostIds(store)]).toEqual(['ssh:target-1'])
    })

    it('hides only the worktrees on the retained host', () => {
      visibleRepos.mockImplementation(hideRetained)
      const hidden = runtimeHiddenRepos(store)
      expect(hidden.hasRepo(retained)).toBe(true)
      expect(hidden.hasRepo(local)).toBe(false)
      expect(hidden.hasWorktree({ repoId: 'same-project', hostId: 'ssh:target-1' })).toBe(true)
      expect(hidden.hasWorktree({ repoId: 'same-project', hostId: 'local' })).toBe(false)
      // A legacy worktree with no host cannot be placed on either row, and one row is visible.
      expect(hidden.hasWorktree({ repoId: 'same-project' })).toBe(false)
    })

    it('hides a hostless worktree whose every row is hidden', () => {
      visibleRepos.mockImplementation(() => [])
      expect(runtimeHiddenRepos(store).hasWorktree({ repoId: 'same-project' })).toBe(true)
    })
  })
})
