import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { removeOrcaCreatedProjectTrustEntries } from '../codex/config-toml-trust'

/**
 * Drops the Codex pretrust entries Orca wrote for a removed worktree's path.
 *
 * Why: worktree IDs are path-derived and can be recreated, so removal must purge
 * history and process-local caches before the ID points at new state. The Codex
 * pretrust entry Orca wrote for the path is the same hazard: drop it so a
 * recreated worktree is not born pre-trusted (#24697). The grant keyed the bare
 * path, so a folder session's ::workspace:<uuid> suffix must not hide it.
 */
export function dropOrcaCreatedCodexPretrustForRemovedWorktree(worktreeId: string): void {
  const worktreePath = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
  if (worktreePath) {
    void removeOrcaCreatedProjectTrustEntries(worktreePath)
  }
}
