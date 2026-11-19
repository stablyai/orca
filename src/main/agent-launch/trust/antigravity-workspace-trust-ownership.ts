import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { createAgentTrustOwnershipLedger } from './agent-trust-ownership-ledger'
import { getOrcaUserDataPath } from '../../codex/configuration/homes/codex-home-paths'

/** Orca's record of the Antigravity entries it created; also the key serializing their edits. */
export function getAntigravityTrustLedgerPath(): string {
  return join(getOrcaUserDataPath(), 'antigravity-workspace-trust-created.json')
}

// Why resolve, not realpath: removal runs after the worktree directory is gone.
function ownershipAt(ledgerPath: string): ReturnType<typeof createAgentTrustOwnershipLedger> {
  return createAgentTrustOwnershipLedger(
    () => ledgerPath,
    (projectPath) => resolve(projectPath)
  )
}

/** Records the `trustedWorkspaces` entry Orca appended for `workspacePath`. */
export function recordOrcaCreatedAntigravityTrust(
  settingsPath: string,
  workspacePath: string,
  entry: string
): void {
  try {
    ownershipAt(getAntigravityTrustLedgerPath()).record(settingsPath, workspacePath, entry)
  } catch (error) {
    // Why: the grant already landed; an unrecorded entry only loses cleanup, never safety.
    console.warn('[antigravity-trust] Failed to record the created workspace trust entry:', error)
  }
}

/**
 * Removes the `trustedWorkspaces` entries Orca appended for `workspacePath`; never throws.
 * Runs on the Codex project trust worker, so its reads and Windows rename retries stay off main.
 */
export function removeOrcaCreatedAntigravityTrust(ledgerPath: string, workspacePath: string): void {
  const ownership = ownershipAt(ledgerPath)
  for (const settingsPath of ownership.listConfigFiles(workspacePath)) {
    try {
      removeRecordedEntry(ownership, settingsPath, workspacePath)
    } catch (error) {
      // Why: keep the record so a later removal can retry an unreadable settings file.
      console.warn('[antigravity-trust] Failed to remove an Orca-created trust entry:', error)
    }
  }
}

function removeRecordedEntry(
  ownership: ReturnType<typeof ownershipAt>,
  settingsPath: string,
  workspacePath: string
): void {
  const entry = ownership.getWritten(settingsPath, workspacePath)
  if (entry === null || !existsSync(settingsPath)) {
    ownership.forget(settingsPath, workspacePath)
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
  ownership.forget(settingsPath, workspacePath)
}
