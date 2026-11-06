import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { removeOrcaCreatedProjectTrustEntries } from '../codex/trust/toml/config-toml-trust'
import { removeOrcaCreatedAntigravityTrust } from '../agent-launch/trust/antigravity-workspace-trust-ownership'

/**
 * Drops the workspace trust entries Orca's preflight wrote for a removed
 * worktree's path (Codex `[projects."<path>"]`, Antigravity `trustedWorkspaces`).
 *
 * Why: worktree IDs are path-derived and can be recreated, so a stale entry would
 * pre-trust the next occupant of the path (#24697). The grant keyed the bare
 * path, so a folder session's ::workspace:<uuid> suffix must not hide it.
 *
 * Resolves once every recorded entry is written out so a removal can await it.
 * Errors degrade to a warning: an unwritable config must not fail an accepted
 * removal, and the ownership record stays for a later pass.
 */
export function dropOrcaCreatedAgentTrustForRemovedWorktree(worktreeId: string): Promise<void> {
  const worktreePath = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
  if (!worktreePath) {
    return Promise.resolve()
  }
  removeOrcaCreatedAntigravityTrust(worktreePath)
  return removeOrcaCreatedProjectTrustEntries(worktreePath).catch((error) => {
    console.warn('[codex-config] Failed to drop an Orca-created project trust entry:', error)
  })
}
