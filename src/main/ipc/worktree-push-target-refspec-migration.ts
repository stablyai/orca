// Narrow legacy fork fetches and prune previously imported branches; include metadata-free pr-* remotes only with stock-wide refspecs.

import { gitExecFileAsync } from '../git/runner'
import { maintainForkRemotes } from '../git/fork-remote-refspec'
import {
  forkRemoteMetadata,
  type GitRemoteExec,
  type WorktreePushTargetStore
} from './worktree-push-target-cleanup'

export async function migrateForkRemoteRefspecsWithExec(
  repoPath: string,
  repoId: string,
  store: WorktreePushTargetStore,
  execGit: GitRemoteExec,
  scope = ''
): Promise<string[]> {
  return maintainForkRemotes(execGit, repoPath, {
    mode: 'migrate',
    scope,
    existingBranchesOnly: true,
    read: () => {
      const metadata = forkRemoteMetadata(store, repoId).map(({ meta }) => meta)
      const referenced = new Set(
        metadata.flatMap((meta) => (meta.pushTarget ? [meta.pushTarget.remoteName] : []))
      )
      return { metadata, select: (name) => name.startsWith('pr-') || referenced.has(name) }
    }
  })
}

// Rate-limit subprocess-heavy migration per repo across bursts of worktree creation.
const MIGRATE_COOLDOWN_MS = 60 * 60 * 1000
const lastMigratedAtByRepoId = new Map<string, number>()

function shouldMigrateNow(repoId: string): boolean {
  const last = lastMigratedAtByRepoId.get(repoId)
  return last === undefined || Date.now() - last >= MIGRATE_COOLDOWN_MS
}

export function _resetForkRemoteRefspecMigrationRateLimitForTests(): void {
  lastMigratedAtByRepoId.clear()
}

/** Best-effort, rate-limited sweep; call sites fire this without awaiting it. */
export async function migrateForkRemoteRefspecs(
  repoPath: string,
  repoId: string,
  store: WorktreePushTargetStore,
  gitOptions: { wslDistro?: string } = {}
): Promise<void> {
  if (!shouldMigrateNow(repoId)) {
    return
  }
  lastMigratedAtByRepoId.set(repoId, Date.now())
  try {
    const migrated = await migrateForkRemoteRefspecsWithExec(
      repoPath,
      repoId,
      store,
      (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions }),
      gitOptions.wslDistro
    )
    if (migrated.length > 0) {
      console.log(
        `[worktrees] Narrowed fetch refspec for ${migrated.length} fork remote(s) in ${repoPath}: ${migrated.join(', ')}`
      )
    }
  } catch (error) {
    console.warn(`[worktrees] Fork remote refspec migration failed for ${repoPath}:`, error)
  }
}
