import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readAgentStateJsonFileSync } from '../agent-state-file-reader'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getOrcaUserDataPath } from './codex-home-paths'
import { normalizeCodexTrustProjectPath } from './codex-trust-identity'

/**
 * Ownership records for the `[projects."<path>"]` tables Orca's preflight trust
 * created, so a removed worktree's entry can be deleted without ever touching a
 * table the user (or an older Orca build) had at that path. Same shape of
 * bookkeeping as the managed-home resource-copy markers: Orca-side state that
 * distinguishes what Orca wrote from what it only found.
 */

const CREATED_PROJECT_TRUST_LEDGER_FILE = 'codex-project-trust-created.json'

type CreatedProjectTrustLedger = {
  version: 1
  /** Config file path → project paths whose table Orca's grant created there. */
  created: Record<string, string[]>
}

function getLedgerPath(): string {
  return join(getOrcaUserDataPath(), CREATED_PROJECT_TRUST_LEDGER_FILE)
}

// Why: the ledger only decides what extra cleanup may happen, so any unreadable
// state degrades to "nothing recorded", never to deleting an unrecorded entry.
function readLedger(): CreatedProjectTrustLedger {
  try {
    const parsed = readAgentStateJsonFileSync(getLedgerPath()) as Partial<CreatedProjectTrustLedger>
    return parsed && typeof parsed === 'object' && typeof parsed.created === 'object'
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

function isRecordedProjectTrust(recorded: string, projectPath: string): boolean {
  return normalizeCodexTrustProjectPath(recorded) === normalizeCodexTrustProjectPath(projectPath)
}

function hasRecord(
  ledger: CreatedProjectTrustLedger,
  configPath: string,
  projectPath: string
): boolean {
  return (ledger.created[configPath] ?? []).some((recorded) =>
    isRecordedProjectTrust(recorded, projectPath)
  )
}

/** Records that Orca's grant created the project table at `projectPath` in `configPath`. */
export function recordOrcaCreatedProjectTrust(configPath: string, projectPath: string): void {
  const ledger = readLedger()
  if (hasRecord(ledger, configPath, projectPath)) {
    return
  }
  ledger.created[configPath] = [...(ledger.created[configPath] ?? []), projectPath]
  writeLedger(ledger)
}

/** Config files whose project table at `projectPath` was created by Orca's grant. */
export function listOrcaCreatedProjectTrustConfigFiles(projectPath: string): string[] {
  const ledger = readLedger()
  return Object.entries(ledger.created)
    .filter(([, paths]) => paths.some((recorded) => isRecordedProjectTrust(recorded, projectPath)))
    .map(([configPath]) => configPath)
}

/** Drops the ownership record once the entry is gone (or its config file is). */
export function forgetOrcaCreatedProjectTrust(configPath: string, projectPath: string): void {
  const ledger = readLedger()
  if (!hasRecord(ledger, configPath, projectPath)) {
    return
  }
  const remaining = (ledger.created[configPath] ?? []).filter(
    (recorded) => !isRecordedProjectTrust(recorded, projectPath)
  )
  if (remaining.length === 0) {
    delete ledger.created[configPath]
  } else {
    ledger.created[configPath] = remaining
  }
  writeLedger(ledger)
}
