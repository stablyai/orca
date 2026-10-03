import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readAgentStateJsonFileSync } from '../agent-state-file-reader'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getOrcaUserDataPath } from './codex-home-paths'
import { normalizeCodexTrustProjectPath } from './codex-trust-identity'

/**
 * Ownership records for the `[projects."<path>"]` tables Orca's preflight trust
 * created, so a removed worktree's entry can be deleted without ever touching a
 * table the user (or an older Orca build) had at that path. Each record carries
 * the exact bytes the grant wrote, so a table replaced afterwards is no longer
 * Orca's to delete. Same shape of bookkeeping as the managed-home resource-copy
 * markers: Orca-side state that distinguishes what Orca wrote from what it only
 * found.
 */

const CREATED_PROJECT_TRUST_LEDGER_FILE = 'codex-project-trust-created.json'

type CreatedProjectTrustEntry = {
  path: string
  /** The table bytes the grant wrote; compared at removal modulo the trailing separator. */
  table: string
}

type CreatedProjectTrustLedger = {
  version: 1
  /** Config file path → the tables Orca's grant created there, with the bytes it wrote. */
  created: Record<string, CreatedProjectTrustEntry[]>
}

function getLedgerPath(): string {
  return join(getOrcaUserDataPath(), CREATED_PROJECT_TRUST_LEDGER_FILE)
}

function isCreatedTrustEntry(entry: unknown): entry is CreatedProjectTrustEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'path' in entry &&
    typeof entry.path === 'string' &&
    'table' in entry &&
    typeof entry.table === 'string'
  )
}

function isCreatedTrustEntryMap(
  value: unknown
): value is Record<string, CreatedProjectTrustEntry[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value).every(
    (entries) => Array.isArray(entries) && entries.every(isCreatedTrustEntry)
  )
}

// Why: the ledger only decides what extra cleanup may happen, so any unreadable
// state degrades to "nothing recorded", never to deleting an unrecorded entry.
function readLedger(): CreatedProjectTrustLedger {
  try {
    const parsed: unknown = readAgentStateJsonFileSync(getLedgerPath())
    return typeof parsed === 'object' &&
      parsed !== null &&
      'created' in parsed &&
      isCreatedTrustEntryMap(parsed.created)
      ? { version: 1, created: parsed.created }
      : { version: 1, created: {} }
  } catch {
    return { version: 1, created: {} }
  }
}

function writeLedger(ledger: CreatedProjectTrustLedger): void {
  const ledgerPath = getLedgerPath()
  mkdirSync(dirname(ledgerPath), { recursive: true })
  writeFileAtomically(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
}

function isRecordedProjectTrust(recorded: CreatedProjectTrustEntry, projectPath: string): boolean {
  return (
    normalizeCodexTrustProjectPath(recorded.path) === normalizeCodexTrustProjectPath(projectPath)
  )
}

function findRecord(
  ledger: CreatedProjectTrustLedger,
  configPath: string,
  projectPath: string
): CreatedProjectTrustEntry | undefined {
  return (ledger.created[configPath] ?? []).find((recorded) =>
    isRecordedProjectTrust(recorded, projectPath)
  )
}

/**
 * Records that Orca's grant created the project table at `projectPath` in
 * `configPath`, vouching for exactly the `table` bytes it wrote.
 */
export function recordOrcaCreatedProjectTrust(
  configPath: string,
  projectPath: string,
  table: string
): void {
  const ledger = readLedger()
  if (findRecord(ledger, configPath, projectPath)) {
    return
  }
  ledger.created[configPath] = [...(ledger.created[configPath] ?? []), { path: projectPath, table }]
  writeLedger(ledger)
}

/** The table bytes Orca's grant recorded for `projectPath` in `configPath`, if any. */
export function getOrcaCreatedProjectTrustTable(
  configPath: string,
  projectPath: string
): string | null {
  return findRecord(readLedger(), configPath, projectPath)?.table ?? null
}

/** Config files whose project table at `projectPath` was created by Orca's grant. */
export function listOrcaCreatedProjectTrustConfigFiles(projectPath: string): string[] {
  const ledger = readLedger()
  return Object.entries(ledger.created)
    .filter(([, entries]) =>
      entries.some((recorded) => isRecordedProjectTrust(recorded, projectPath))
    )
    .map(([configPath]) => configPath)
}

/** Drops the ownership record once the entry is gone (or its config file is). */
export function forgetOrcaCreatedProjectTrust(configPath: string, projectPath: string): void {
  const ledger = readLedger()
  const entries = ledger.created[configPath] ?? []
  const remaining = entries.filter((recorded) => !isRecordedProjectTrust(recorded, projectPath))
  if (remaining.length === entries.length) {
    return
  }
  if (remaining.length === 0) {
    delete ledger.created[configPath]
  } else {
    ledger.created[configPath] = remaining
  }
  writeLedger(ledger)
}
