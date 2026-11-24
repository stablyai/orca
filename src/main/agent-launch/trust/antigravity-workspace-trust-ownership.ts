import { join, resolve } from 'node:path'
import { createAgentTrustOwnershipLedger } from './agent-trust-ownership-ledger'
import { getOrcaUserDataPath } from '../../codex/configuration/homes/codex-home-paths'

/** Orca's record of the Antigravity entries it created; also the key serializing their edits. */
export function getAntigravityTrustLedgerPath(): string {
  return join(getOrcaUserDataPath(), 'antigravity-workspace-trust-created.json')
}

// Why resolve, not realpath: removal runs after the worktree directory is gone.
const antigravityTrustOwnership = createAgentTrustOwnershipLedger(
  getAntigravityTrustLedgerPath,
  (projectPath) => resolve(projectPath)
)

/** Records the `trustedWorkspaces` entry Orca appended for `workspacePath`. */
export function recordOrcaCreatedAntigravityTrust(
  settingsPath: string,
  workspacePath: string,
  entry: string
): void {
  try {
    antigravityTrustOwnership.record(settingsPath, workspacePath, entry)
  } catch (error) {
    // Why: the grant already landed; an unrecorded entry only loses cleanup, never safety.
    console.warn('[antigravity-trust] Failed to record the created workspace trust entry:', error)
  }
}
