import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeFileAtomically } from '../../codex-accounts/fs-utils'
import { createAgentTrustOwnershipLedger } from './agent-trust-ownership-ledger'

// Why resolve, not realpath: removal runs after the worktree directory is gone.
const antigravityTrustOwnership = createAgentTrustOwnershipLedger(
  'antigravity-workspace-trust-created.json',
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

/** Removes the `trustedWorkspaces` entries Orca appended for `workspacePath`; never throws. */
export function removeOrcaCreatedAntigravityTrust(workspacePath: string): void {
  for (const settingsPath of antigravityTrustOwnership.listConfigFiles(workspacePath)) {
    try {
      removeRecordedEntry(settingsPath, workspacePath)
    } catch (error) {
      // Why: keep the record so a later removal can retry an unreadable settings file.
      console.warn('[antigravity-trust] Failed to remove an Orca-created trust entry:', error)
    }
  }
}

function removeRecordedEntry(settingsPath: string, workspacePath: string): void {
  const entry = antigravityTrustOwnership.getWritten(settingsPath, workspacePath)
  if (entry === null || !existsSync(settingsPath)) {
    antigravityTrustOwnership.forget(settingsPath, workspacePath)
    return
  }
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const config: Record<string, unknown> = { ...parsed }
    const trusted = Array.isArray(config.trustedWorkspaces) ? config.trustedWorkspaces : []
    const remaining = trusted.filter((existing) => existing !== entry)
    if (remaining.length !== trusted.length) {
      config.trustedWorkspaces = remaining
      writeFileAtomically(settingsPath, `${JSON.stringify(config, null, 2)}\n`)
    }
  }
  antigravityTrustOwnership.forget(settingsPath, workspacePath)
}
