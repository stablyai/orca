/** Same repo ids may exist on multiple hosts; repo.rm resolves one row and must delete only that host registration, including unambiguous path/name selectors (#11994). */
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { OrcaRuntimeService } from '../orca-runtime'
import { findRepoRowForHostScopedWrite } from '../../persistence/tracking-repos/repo-update-operations'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { RepoHostTarget } from '../../../shared/repo-host-identity'
import { partialRuntimeStore } from './runtime-store-partial-fixture'
import { withProjectWorktreeCreate } from '../../workspaces/creation/worktree-create-in-flight'

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
    it('refuses a bare duplicated id rather than guessing a host', async () => {
      const { runtime, repos, removeProjectForHost } = createRuntime()

      await expect(runtime.removeProject('dup')).rejects.toThrow('selector_ambiguous')
      expect(removeProjectForHost).not.toHaveBeenCalled()
      expect(repos).toHaveLength(2)
    })
  })

  describe('repo.rm while a workspace create is open', () => {
    it('refuses the host row whose create is open, not its same-id twin', async () => {
      const { runtime, repos, removeProjectForHost } = createRuntime()
      const holdCreate = (repo: Repo) => {
        let finish!: () => void
        const create = withProjectWorktreeCreate(repo, () => new Promise<void>((r) => (finish = r)))
        return () => {
          finish()
          return create
        }
      }

      const finishRemoteCreate = holdCreate(repos[1])
      await expect(runtime.removeProject('path:/remote/dup')).rejects.toMatchObject({
        code: 'worktree_create_in_progress'
      })
      expect(removeProjectForHost).not.toHaveBeenCalled()
      await finishRemoteCreate()

      const finishLocalCreate = holdCreate(repos[0])
      await runtime.removeProject('path:/remote/dup')
      await finishLocalCreate()
      expect(repos.map((repo) => repo.path)).toEqual(['/laptop/dup'])
    })
  })
}
