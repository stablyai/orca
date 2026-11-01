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
 *
 * Resolves only once every recorded entry has been written out, so a removal
 * can await it and never report the worktree gone while the path would still
 * inherit `trust_level = "trusted"` on rebuild. Await is for ordering, not
 * failure propagation: a write that cannot land (read-only config.toml and
 * alike) must not turn an accepted removal into a failed one, so errors
 * degrade to this warn — the ownership record stays for a later pass.
 */
export function dropOrcaCreatedCodexPretrustForRemovedWorktree(worktreeId: string): Promise<void> {
  const worktreePath = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
  if (!worktreePath) {
    return Promise.resolve()
  }
  return removeOrcaCreatedProjectTrustEntries(worktreePath).catch((error) => {
    console.warn('[codex-config] Failed to drop an Orca-created project trust entry:', error)
  })
}
