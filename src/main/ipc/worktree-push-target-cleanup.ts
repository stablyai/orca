import type { Store } from '../persistence'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { maintainForkRemotes, sameForkRepository } from '../git/fork-remote-refspec'

export type GitRemoteExec = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr?: string }>
export type WorktreePushTargetStore = Pick<Store, 'getAllWorktreeMeta'> &
  Partial<Pick<Store, 'setWorktreeMeta' | 'getRepos' | 'getAllWorktreeMetaForHost'>>
export const sameGitHubRemoteUrl = sameForkRepository

export function forkRemoteMetadata(
  store: WorktreePushTargetStore,
  repoId: string
): { worktreeId: string; meta: WorktreeMeta }[] {
  const hosts = new Set(
    store
      .getRepos?.()
      .filter((repo) => repo.id === repoId)
      .map(getRepoExecutionHostId)
  )
  const owner = hosts.size === 1 ? [...hosts][0] : undefined
  const qualify = (entries: Record<string, WorktreeMeta>, host = owner) =>
    Object.fromEntries(
      Object.entries(entries).map(([id, meta]) => [id, { ...meta, hostId: meta.hostId ?? host }])
    )
  const rows = [qualify(store.getAllWorktreeMeta())]
  for (const host of hosts) {
    const qualified = store.getAllWorktreeMetaForHost?.(host)
    if (qualified) {
      rows.push(qualify(qualified, host))
    }
  }
  return rows.flatMap((entries) =>
    Object.entries(entries).flatMap(([worktreeId, meta]) =>
      getRepoIdFromWorktreeId(worktreeId) === repoId ? [{ worktreeId, meta }] : []
    )
  )
}

export async function cleanupUnusedWorktreePushTargetRemoteWithExec(
  repoPath: string,
  removedWorktreeId: string,
  target: GitPushTarget | undefined,
  store: WorktreePushTargetStore,
  execGit: GitRemoteExec,
  scope = ''
): Promise<void> {
  if (!target?.remoteUrl) {
    return
  }
  await maintainForkRemotes(execGit, repoPath, {
    mode: 'remove',
    names: new Map([[target.remoteName, target.remoteUrl]]),
    scope,
    read: () => {
      const repoId = getRepoIdFromWorktreeId(removedWorktreeId)
      const hosts = new Set(
        store
          .getRepos?.()
          .filter((repo) => repo.id === repoId)
          .map(getRepoExecutionHostId)
      )
      const removedHost =
        store.getAllWorktreeMeta()[removedWorktreeId]?.hostId ??
        (hosts.size === 1 ? [...hosts][0] : undefined)
      return {
        metadata: forkRemoteMetadata(store, repoId)
          .filter(
            ({ worktreeId, meta }) =>
              worktreeId !== removedWorktreeId ||
              meta.hostId !== removedHost ||
              (removedHost === undefined && hosts.size > 1)
          )
          .map(({ meta }) => meta)
      }
    }
  })
}
