import { observe } from '../../configuration/codex-path-observation'
import { writeTomlConfigAtomically } from '../../configuration/toml/config-toml-atomic-write'
import { normalizeCodexTrustProjectPath } from '../identity/codex-trust-identity'
import { readTomlFile, readTomlForMutation } from '../toml/config-toml-trust'
import {
  findProjectTrustRemovedBytes,
  hasProjectTrustEntry,
  removeProjectTrustContent,
  upsertProjectTrustContent
} from '../toml/config-toml-project-trust'
import {
  createAgentTrustOwnershipLedger,
  type AgentTrustOwnershipLedger,
  type CreatedTrustRecord
} from '../../../agent-launch/trust/agent-trust-ownership-ledger'
import { canonicalizeAgentTrustPath } from '../../../agent-launch/trust/agent-trust-path-canonicalization'

/**
 * Codex project trust grants and their ownership cleanup. Runs only on the Codex project trust
 * worker, whose one-request-at-a-time queue is the ownership ledger's only writer; the caller
 * holds every config's mutation lock for the whole request.
 */

function openLedger(ledgerPath: string): AgentTrustOwnershipLedger {
  return createAgentTrustOwnershipLedger(() => ledgerPath, normalizeCodexTrustProjectPath)
}

/** Writes `trusted` into each config in order, then records the tables it created in one ledger publication. */
export function grantCodexProjectTrust(
  configFiles: readonly string[],
  workspacePath: string,
  ledgerPath: string
): void {
  // Codex checks the starting folder before its repository root; no Git-layout lookup is needed.
  const projectPath = canonicalizeAgentTrustPath(workspacePath)
  const created: CreatedTrustRecord[] = []
  try {
    for (const configPath of configFiles) {
      const record = upsertOrcaCreatedProjectTrust(configPath, projectPath)
      if (record) {
        created.push(record)
      }
    }
  } finally {
    // Why: configs written before a later one failed still need their records for cleanup.
    try {
      openLedger(ledgerPath).recordAll(created)
    } catch (error) {
      // Why: the grant already landed; an unrecorded entry only loses cleanup, never safety.
      console.warn('[codex-config] Failed to record the created project trust entry:', error)
    }
  }
}

/** The record a newly created `[projects."<path>"]` table needs, or null when the table already existed. */
function upsertOrcaCreatedProjectTrust(
  configPath: string,
  projectPath: string
): CreatedTrustRecord | null {
  const existing = readTomlForMutation(configPath)
  const created = !hasProjectTrustEntry(existing, projectPath)
  const updated = upsertProjectTrustContent(existing, projectPath, 'trusted')
  if (updated !== existing) {
    writeTomlConfigAtomically(configPath, updated)
  }
  return created
    ? { configPath, projectPath, written: findProjectTrustRemovedBytes(updated, projectPath) ?? '' }
    : null
}

export function listCodexProjectTrustOwnedConfigs(
  projectPath: string,
  ledgerPath: string
): string[] {
  return openLedger(ledgerPath).listConfigFiles(projectPath)
}

// Why: the separator below a table belongs to what follows it, not to the table Orca wrote.
function withoutTrailingSeparator(bytes: string): string {
  return bytes.replace(/[\r\n]+$/, '')
}

/** Removes the table only while it still holds exactly what Orca wrote; throws to keep the record for a retry. */
export function removeOrcaCreatedProjectTrust(
  configPath: string,
  projectPath: string,
  ledgerPath: string
): void {
  const ledger = openLedger(ledgerPath)
  const observation = observe(() => readTomlFile(configPath))
  if (observation.kind === 'indeterminate') {
    return
  }
  if (observation.kind === 'absent') {
    ledger.forget(configPath, projectPath)
    return
  }
  const ownedTable = ledger.getWritten(configPath, projectPath)
  const currentTable = findProjectTrustRemovedBytes(observation.value, projectPath)
  if (
    ownedTable === null ||
    currentTable === null ||
    withoutTrailingSeparator(currentTable) !== withoutTrailingSeparator(ownedTable)
  ) {
    // Why: the bytes at the path are no longer what Orca wrote, so the record no longer vouches
    // for the table — dropping it keeps a later pass from deleting someone else's replacement.
    ledger.forget(configPath, projectPath)
    return
  }
  const updated = removeProjectTrustContent(observation.value, projectPath)
  if (updated !== observation.value) {
    writeTomlConfigAtomically(configPath, updated)
  }
  ledger.forget(configPath, projectPath)
}
