/** Same repo ids may exist on multiple hosts; repo.rm resolves one row and must delete only that host registration, including unambiguous path/name selectors (#11994). */
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { OrcaRuntimeService } from './orca-runtime'
import { findRepoRowForHostScopedWrite } from '../persistence/tracking-repos/repo-update-operations'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { RepoHostTarget } from '../../shared/repo-host-identity'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

export function registerRuntimeRemoveProjectHostScopeTests(): void {
  function makeRepos(): Repo[] {
    return [
      {
        id: 'dup',
        path: '/laptop/dup',
        displayName: 'Dup Local',
        badgeColor: '#000',
        addedAt: 1,
        executionHostId: 'local'
      },
      {
        id: 'dup',
        path: '/remote/dup',
        displayName: 'Dup Remote',
        badgeColor: '#000',
        addedAt: 2,
        connectionId: 'ssh-1'
      }
    ]
  }

  function createRuntime() {
    const repos = makeRepos()
    const removeProjectForHost = vi.fn((target: RepoHostTarget) => {
      const id = target.id
      const hostId = getRepoExecutionHostId(target)
      for (let index = repos.length - 1; index >= 0; index -= 1) {
        const repo = repos[index]
        const repoHostId =
          repo.executionHostId ?? (repo.connectionId ? `ssh:${repo.connectionId}` : 'local')
        if (repo.id === id && repoHostId === hostId) {
          repos.splice(index, 1)
        }
      }
    })
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getRepos: () => [...repos],
        getRepo: (id: string) => repos.find((repo) => repo.id === id),
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        setWorktreeMeta: vi.fn(),
        removeWorktreeMeta: vi.fn(),
        // Same row lookup the real store's host-scoped write uses.
        updateRepo: (target: RepoHostTarget, updates: Partial<Repo>) => {
          const row = findRepoRowForHostScopedWrite(
            repos,
            target.id,
            getRepoExecutionHostId(target)
          )
          return row ? Object.assign(row, updates) : null
        },
        moveProjectToGroup: (target: RepoHostTarget, groupId: string | null) => {
          const row = findRepoRowForHostScopedWrite(
            repos,
            target.id,
            getRepoExecutionHostId(target)
          )
          return row ? Object.assign(row, { projectGroupId: groupId }) : null
        },
        removeProjectForHost
      })
    )
    return { runtime, repos, removeProjectForHost }
  }

  describe('repo.rm with the same repo id on two execution hosts', () => {
    it('removes only the resolved row when a path selector picks the SSH host copy', async () => {
      const { runtime, repos } = createRuntime()

      await runtime.removeProject('path:/remote/dup')

      expect(repos.map((repo) => repo.path)).toEqual(['/laptop/dup'])
    })

    it('removes only the resolved row when a name selector picks the local copy', async () => {
      const { runtime, repos } = createRuntime()

      await runtime.removeProject('name:Dup Local')

      expect(repos.map((repo) => repo.path)).toEqual(['/remote/dup'])
    })

    it('refuses a bare duplicated id rather than guessing a host', async () => {
      const { runtime, repos, removeProjectForHost } = createRuntime()

      await expect(runtime.removeProject('dup')).rejects.toThrow('selector_ambiguous')
      expect(removeProjectForHost).not.toHaveBeenCalled()
      expect(repos).toHaveLength(2)
    })
  })

  describe('projectGroup.moveProject with the same repo id on two execution hosts', () => {
    it('moves the SSH row a path selector picked, not its local sibling', async () => {
      const { runtime, repos } = createRuntime()

      await runtime.moveProjectToGroup('path:/remote/dup', 'group-1')

      expect(repos.map((repo) => repo.projectGroupId)).toEqual([undefined, 'group-1'])
    })

    it('moves the local row a name selector picked, not its SSH sibling', async () => {
      const { runtime, repos } = createRuntime()

      const moved = await runtime.moveProjectToGroup('name:Dup Local', 'group-1')

      expect(moved).toMatchObject({ path: '/laptop/dup', projectGroupId: 'group-1' })
      expect(repos.map((repo) => repo.projectGroupId)).toEqual(['group-1', undefined])
    })

    it('refuses a bare duplicated id rather than guessing a host', async () => {
      const { runtime, repos } = createRuntime()

      await expect(runtime.moveProjectToGroup('dup', 'group-1')).rejects.toThrow(
        'selector_ambiguous'
      )
      expect(repos.map((repo) => repo.projectGroupId)).toEqual([undefined, undefined])
    })

    it('moves the SSH row a paired client names by its connection', async () => {
      const { runtime, repos } = createRuntime()

      await runtime.moveProjectToGroup('dup', 'group-1', undefined, 'ssh-1')

      expect(repos.map((repo) => repo.projectGroupId)).toEqual([undefined, 'group-1'])
    })

    it('moves the local row a paired client names with no connection', async () => {
      const { runtime, repos } = createRuntime()

      await runtime.moveProjectToGroup('dup', 'group-1', undefined, null)

      expect(repos.map((repo) => repo.projectGroupId)).toEqual(['group-1', undefined])
    })
  })

  describe('repo.update with the same repo id on two execution hosts', () => {
    it('writes the SSH row a path selector picked, not its local sibling', async () => {
      const { runtime, repos } = createRuntime()

      await runtime.updateRepo('path:/remote/dup', { displayName: 'Renamed Remote' })

      expect(repos.map((repo) => repo.displayName)).toEqual(['Dup Local', 'Renamed Remote'])
    })

    it('sets the base ref on the SSH row a path selector picked', async () => {
      const { runtime, repos } = createRuntime()

      await runtime.setRepoBaseRef('path:/remote/dup', 'origin/dev')

      expect(repos.map((repo) => repo.worktreeBaseRef)).toEqual([undefined, 'origin/dev'])
    })
  })
}
