import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR, splitWorktreeId } from '../../shared/worktree/id'
import { removeOrcaCreatedProjectTrustEntries } from '../codex/trust/toml/config-toml-trust'
import { removeOrcaCreatedAntigravityTrust } from '../agent-launch/trust/antigravity-workspace-trust-ownership'

/**
 * Drops the workspace trust entries Orca's preflight wrote for a removed
 * worktree's path (Codex `[projects."<path>"]`, Antigravity `trustedWorkspaces`).
 *
 * Why: worktree IDs are path-derived and can be recreated, so a stale entry would
 * pre-trust the next occupant of the path (#24697). Only call this once the
 * directory itself was deleted. A folder-workspace session id (::workspace:<uuid>)
 * names a folder that stays on disk for its siblings, so it never drops trust.
 *
 * Resolves once every recorded entry is written out so a removal can await it.
 * Errors degrade to a warning: an unwritable config must not fail an accepted
 * removal, and the ownership record stays for a later pass.
 */
export function dropOrcaCreatedAgentTrustForRemovedWorktree(worktreeId: string): Promise<void> {
  const worktreePath = splitWorktreeId(worktreeId)?.worktreePath
  if (!worktreePath || worktreePath.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)) {
    return Promise.resolve()
  }
  removeOrcaCreatedAntigravityTrust(worktreePath)
  return removeOrcaCreatedProjectTrustEntries(worktreePath).catch((error) => {
    console.warn('[codex-config] Failed to drop an Orca-created project trust entry:', error)
  })
}
