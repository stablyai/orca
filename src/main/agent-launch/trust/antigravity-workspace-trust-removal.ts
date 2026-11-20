import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { createAgentTrustOwnershipLedger } from './agent-trust-ownership-ledger'

/**
 * Worker-only: removes the `trustedWorkspaces` entries Orca appended for `workspacePath`, keeping
 * any the user had or changed. Runs on the Codex project trust worker so its reads and Windows
 * rename retries stay off Electron main. Never throws.
 */
export function removeOrcaCreatedAntigravityTrust(ledgerPath: string, workspacePath: string): void {
  // Why resolve, not realpath: removal runs after the worktree directory is gone.
  const ownership = createAgentTrustOwnershipLedger(
    () => ledgerPath,
    (projectPath) => resolve(projectPath)
  )
  for (const settingsPath of ownership.listConfigFiles(workspacePath)) {
    try {
      const entry = ownership.getWritten(settingsPath, workspacePath)
      if (entry !== null && existsSync(settingsPath)) {
        removeEntry(settingsPath, entry)
      }
      ownership.forget(settingsPath, workspacePath)
    } catch (error) {
      // Why: keep the record so a later removal can retry an unreadable settings file.
      console.warn('[antigravity-trust] Failed to remove an Orca-created trust entry:', error)
    }
  }
}

function removeEntry(settingsPath: string, entry: string): void {
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return
  }
  const config: Record<string, unknown> = { ...parsed }
  const trusted = Array.isArray(config.trustedWorkspaces) ? config.trustedWorkspaces : []
  const remaining = trusted.filter((existing) => existing !== entry)
  if (remaining.length !== trusted.length) {
    config.trustedWorkspaces = remaining
    writeFileAtomically(settingsPath, `${JSON.stringify(config, null, 2)}\n`)
  }
}
