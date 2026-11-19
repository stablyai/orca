import { readFileSync } from 'node:fs'
import { writeTomlConfigAtomically } from '../../configuration/toml/config-toml-atomic-write'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { normalizeCodexTrustProjectPath } from '../identity/codex-trust-identity'
import { stripLeadingBom } from '../toml/config-toml-trust'
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
 * holds every config's mutation lock for the whole request. Some main-thread writers replace
 * these configs without that lock, so every publication is conditional on the bytes it read: a
 * newer edit is redone, never overwritten. A main writer can still drop a grant's table; the
 * next launch re-grants it.
 */

const PUBLISH_ATTEMPTS = 3

type ConfigEdit = { raw: string | null; updated: string; record: CreatedTrustRecord | null }

/** The file's raw bytes (BOM kept), or null when it is definitely absent. */
function readRawConfig(configPath: string): string | null {
  try {
    return readFileSync(configPath, 'utf-8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return null
    }
    throw error
  }
}

/** Publishes only while the file still holds exactly `raw`; checked after the backup, before the rename. */
function publishIfUnchanged(configPath: string, raw: string | null, contents: string): boolean {
  return writeTomlConfigAtomically(configPath, contents, {
    stillCurrent: (writePath) => readRawConfig(writePath) === raw
  })
}

function openLedger(ledgerPath: string): AgentTrustOwnershipLedger {
  return createAgentTrustOwnershipLedger(() => ledgerPath, normalizeCodexTrustProjectPath)
}

function sameRecord(a: CreatedTrustRecord, b: CreatedTrustRecord): boolean {
  return a.configPath === b.configPath && a.written === b.written
}

function planGrant(configPath: string, projectPath: string): ConfigEdit {
  // Only confirmed absence permits seeding an empty config.
  const raw = readRawConfig(configPath)
  const existing = raw === null ? '' : stripLeadingBom(raw)
  const updated = upsertProjectTrustContent(existing, projectPath, 'trusted')
  const created = !hasProjectTrustEntry(existing, projectPath)
  return {
    raw,
    updated: updated === existing ? (raw ?? '') : updated,
    record: created
      ? {
          configPath,
          projectPath,
          written: findProjectTrustRemovedBytes(updated, projectPath) ?? ''
        }
      : null
  }
}

/**
 * Publishes the edit, redoing it from a fresh read when another writer changed the file first.
 * `recordAhead` runs before every publication so its record is in the ledger before its table.
 */
function publishEdit(
  configPath: string,
  edit: ConfigEdit,
  replan: () => ConfigEdit,
  recordAhead: (record: CreatedTrustRecord | null) => void
): CreatedTrustRecord | null {
  let current = edit
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    if (current.updated === (current.raw ?? '') && current.raw !== null) {
      return current.record
    }
    recordAhead(current.record)
    if (publishIfUnchanged(configPath, current.raw, current.updated)) {
      return current.record
    }
    current = replan()
  }
  throw new Error(`${configPath} kept changing while Orca updated its project trust`)
}

/** The records the ledger added, or null when it could not be published. */
function applyLedger(
  ledgerPath: string,
  changes: Parameters<AgentTrustOwnershipLedger['apply']>[0]
): CreatedTrustRecord[] | null {
  try {
    return openLedger(ledgerPath).apply(changes)
  } catch (error) {
    // Why: a grant without its record only loses cleanup, never safety.
    console.warn('[codex-config] Failed to record the created project trust entry:', error)
    return null
  }
}

/**
 * Writes `trusted` into each config in order. Records the tables it is about to create before
 * publishing any config, so a worker stopped mid-grant still leaves cleanup evidence; a record
 * whose table never landed is harmless, removal forgets it on a byte mismatch.
 */
export function grantCodexProjectTrust(
  configFiles: readonly string[],
  workspacePath: string,
  ledgerPath: string
): void {
  // Codex checks the starting folder before its repository root; no Git-layout lookup is needed.
  const projectPath = canonicalizeAgentTrustPath(workspacePath)
  const edits: { configPath: string; edit: ConfigEdit }[] = []
  let failure: unknown
  try {
    for (const configPath of configFiles) {
      edits.push({ configPath, edit: planGrant(configPath, projectPath) })
    }
  } catch (error) {
    // Why: configs before the unreadable one are still granted, as when each was written in turn.
    failure = error
  }
  // Records the ledger now holds for this grant, and the subset this grant added.
  const recorded: CreatedTrustRecord[] = []
  const added: CreatedTrustRecord[] = []
  const recordAhead = (records: CreatedTrustRecord[]): void => {
    const missing = records.filter((record) => !recorded.some((other) => sameRecord(record, other)))
    if (missing.length === 0) {
      return
    }
    // Why: a redo can change a config's table bytes; swap out the record this grant added for it.
    const stale = added.filter((old) =>
      missing.some((record) => record.configPath === old.configPath)
    )
    const newlyAdded = applyLedger(ledgerPath, { record: missing, forget: stale })
    if (newlyAdded) {
      for (const old of stale) {
        added.splice(added.indexOf(old), 1)
        recorded.splice(recorded.indexOf(old), 1)
      }
      recorded.push(...missing)
      added.push(...newlyAdded)
    }
  }
  recordAhead(edits.flatMap(({ edit }) => (edit.record ? [edit.record] : [])))
  const landed: CreatedTrustRecord[] = []
  try {
    for (const { configPath, edit } of edits) {
      const record = publishEdit(
        configPath,
        edit,
        () => planGrant(configPath, projectPath),
        (ahead) => recordAhead(ahead ? [ahead] : [])
      )
      if (record) {
        landed.push(record)
      }
    }
  } catch (error) {
    failure ??= error
  }
  const forget = added.filter((record) => !landed.some((other) => sameRecord(record, other)))
  const record = landed.filter((record) => !recorded.some((other) => sameRecord(record, other)))
  if (forget.length > 0 || record.length > 0) {
    applyLedger(ledgerPath, { record, forget })
  }
  if (failure !== undefined) {
    throw failure
  }
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
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    const raw = readRawConfig(configPath)
    if (raw === null) {
      ledger.forget(configPath, projectPath)
      return
    }
    const content = stripLeadingBom(raw)
    const ownedTable = ledger.getWritten(configPath, projectPath)
    const currentTable = findProjectTrustRemovedBytes(content, projectPath)
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
    const updated = removeProjectTrustContent(content, projectPath)
    if (updated === content || publishIfUnchanged(configPath, raw, updated)) {
      ledger.forget(configPath, projectPath)
      return
    }
  }
  throw new Error(`${configPath} kept changing while Orca removed its project trust`)
}
